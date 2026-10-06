#!/usr/bin/env python3
"""Local file installation and hostile observer qualification. No operator state."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
HOST = ROOT / "target/release/pirs-host"
PLUGIN = ROOT / "target/event-echo.wasm"
MANIFEST = {
    "schemaVersion": 1, "id": "scoped-observer", "minSpecLevel": 0,
    "hooks": ["event.commit"], "capabilities": [
        {"name": "diagnostics.log", "constraints": {}},
        {"name": "events.subscribe", "constraints": {
            "eventTypes": ["commit"], "collections": ["app.bsky.feed.post"]}},
    ],
}


def execute(*args, input=""):
    return subprocess.run([str(HOST), *map(str, args)], input=input, text=True,
                          capture_output=True, timeout=30)


def main():
    checks = {}
    with tempfile.TemporaryDirectory(prefix="pirs-manifest-") as temporary:
        root = Path(temporary)
        source = root / "source.wasm"
        source.write_bytes(PLUGIN.read_bytes())
        manifest_path = root / "manifest.json"
        installs = root / "installs"

        def install(manifest=MANIFEST, plugin=source, success=True):
            manifest_path.write_text(json.dumps(manifest))
            result = execute("--plugin", plugin, "--manifest", manifest_path,
                             "--install-dir", installs)
            if success:
                assert result.returncode == 0, result.stderr
                value = json.loads(result.stdout)
                destination = Path(value["installed"])
                assert destination.name == value["receipt"]["installationId"]
                assert json.loads((destination / "receipt.json").read_text()) == value["receipt"]
                assert value["receipt"]["artifactSha256"] == hashlib.sha256(plugin.read_bytes()).hexdigest()
                assert destination.stat().st_mode & 0o777 == 0o700
                assert all(p.stat().st_mode & 0o777 == 0o600 for p in destination.iterdir())
                return value
            assert result.returncode != 0 and not result.stdout, result
            return result

        original = install()
        installation = original["installed"]
        checks["honest_install_receipt_and_private_permissions"] = True
        assert install() == original
        checks["identical_install_idempotent"] = True
        for name, mutate in [
            ("undeclared_import", lambda m: m["capabilities"].pop(0)),
            ("unknown_category", lambda m: m["capabilities"].append({"name": "alien.read", "constraints": {}})),
            ("unknown_operation", lambda m: m["capabilities"].append({"name": "events.delete", "constraints": {}})),
            ("known_unimplemented", lambda m: m["capabilities"].append({"name": "network.request", "constraints": {"allowedHosts": ["example.com"]}})),
            ("unknown_constraint", lambda m: m["capabilities"][1]["constraints"].update({"collection": "app.bsky.feed.post"})),
            ("unknown_event", lambda m: m["capabilities"][1]["constraints"].update({"eventTypes": ["spaces"]})),
            ("unknown_hook", lambda m: m.update({"hooks": ["event.spaces"]})),
            ("higher_level", lambda m: m.update({"minSpecLevel": 1})),
            ("duplicate_capability", lambda m: m["capabilities"].append(m["capabilities"][0])),
            ("implicit_wildcard", lambda m: m["capabilities"][1]["constraints"].update({"collections": []})),
            ("bad_collection", lambda m: m["capabilities"][1]["constraints"].update({"collections": ["post/*"]})),
            ("unknown_field", lambda m: m.update({"grants": "all"})),
        ]:
            manifest = deepcopy(MANIFEST)
            mutate(manifest)
            before = sorted(installs.iterdir())
            install(manifest, success=False)
            assert sorted(installs.iterdir()) == before, "rejected install wrote state"
            checks[name + "_rejected_before_write"] = True
        rejected = install(plugin=ROOT / "target/forbidden-wasi.wasm", success=False)
        assert "unsupported component import" in rejected.stderr
        checks["wasi_rejected_before_instantiation"] = True
        for name, old, new in [
            ("unknown_import_operation", b"\x03log", b"\x03bad"),
            ("unknown_import_interface", b"pirs:sandbox/diagnostics@0.1.0", b"pirs:sandbox/diagnosticx@0.1.0"),
        ]:
            altered = root / (name + ".wasm")
            original_bytes = PLUGIN.read_bytes()
            assert old in original_bytes
            altered.write_bytes(original_bytes.replace(old, new))
            before = sorted(installs.iterdir())
            install(plugin=altered, success=False)
            assert sorted(installs.iterdir()) == before
            checks[name + "_rejected_before_write"] = True
        # Append a real core start function to the echo component. It loops
        # during instantiation, before run. Preserve all existing indices.
        def leb(value):
            result = bytearray()
            while value >= 128:
                result.append((value & 127) | 128)
                value >>= 7
            return bytes(result + bytes([value]))

        def section(kind, payload):
            return bytes([kind]) + leb(len(payload)) + payload

        artifact = PLUGIN.read_bytes()
        offset, module_count = 8, 0
        while offset < len(artifact):
            kind, offset = artifact[offset], offset + 1
            length, shift = 0, 0
            while True:
                byte = artifact[offset]
                offset += 1
                length |= (byte & 127) << shift
                if byte < 128:
                    break
                shift += 7
            module_count += kind == 1
            offset += length
        # Reuse the echo component's initialized diagnostics trampoline and
        # memory. The core start logs before looping, a visible side effect.
        core_start = (b"\0asm\x01\0\0\0"
            + section(1, bytes.fromhex("0260027f7f00600000"))
            + section(2, b"\x02\x04host\x03log\x00\x00\x04host\x06memory\x02\x00\x01")
            + section(3, b"\x01\x01") + section(8, b"\x01")
            + section(10, b"\x01\x0d" + bytes.fromhex("0041104107100003400c000b0b"))
            + section(11, b"\x01\x00\x41\x10\x0b\x07startup"))
        # Existing fixture has five core instances and aliases core func 0
        # to its log trampoline and core memory 0 to its guest memory.
        host_instance = b"\x01\x01\x02\x03log\x00\x00\x06memory\x02\x00"
        guest_instance = b"\x01\x00" + leb(module_count) + b"\x01\x04host\x12\x05"
        startup_bytes = artifact + section(1, core_start) + section(2, host_instance) + section(2, guest_instance)
        startup = root / "startup.wasm"
        startup.write_bytes(startup_bytes)
        startup_install = install(plugin=startup)
        allowed = {"id": 1, "input": 'event:{"seq":1,"type":"commit","time":"now","evt":{"ops":[{"path":"app.bsky.feed.post/r","action":"create"}]}}'}
        denied = {"id": 2, "input": 'event:{"seq":2,"type":"identity","time":"now","evt":{}}'}
        probe = execute("--installation", startup_install["installed"], "--deadline-ms", "100",
                        input=json.dumps(allowed) + "\n" + json.dumps(denied) + "\n")
        assert probe.returncode == 0, probe.stderr
        startup_rows = [json.loads(line) for line in probe.stdout.splitlines()]
        assert startup_rows[1]["error"] == "timeout" and startup_rows[1]["logs"] == ["startup"], startup_rows
        assert startup_rows[2]["filtered"] and startup_rows[2]["peak_memory_bytes"] == 0 and startup_rows[2]["logs"] == [], startup_rows
        checks["install_skips_startup_and_filter_precedes_startup"] = True
        # Add an ungranted function import after the permitted diagnostics
        # interface. Every import must be checked before that same start.
        name = b"alien:host/escape"
        alien = section(10, b"\x01\x00" + leb(len(name)) + name + b"\x01\x01")
        startup.write_bytes(startup_bytes + alien)
        before = sorted(installs.iterdir())
        rejected = install(plugin=startup, success=False)
        assert "unsupported component import" in rejected.stderr, rejected.stderr
        assert sorted(installs.iterdir()) == before
        checks["all_imports_checked_before_startup_side_effect"] = True
        oversized = root / "oversized.wasm"
        with oversized.open("wb") as file:
            file.truncate(16 * 1024 * 1024 + 1)
        install(plugin=oversized, success=False)
        checks["oversized_artifact_rejected"] = True
        manifest_path.write_text(" " * (64 * 1024 + 1))
        oversized_manifest = execute("--plugin", source, "--manifest", manifest_path, "--install-dir", installs)
        assert oversized_manifest.returncode != 0 and not oversized_manifest.stdout
        checks["oversized_manifest_rejected"] = True
        # A second valid component at the same source path is a new installation.
        source.write_bytes((ROOT / "target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm").read_bytes())
        changed = install()
        assert changed["installed"] != installation
        assert Path(installation, "plugin.wasm").read_bytes() == PLUGIN.read_bytes()
        checks["changed_source_new_install_original_pinned"] = True
        changed_manifest = deepcopy(MANIFEST)
        changed_manifest["capabilities"][1]["constraints"]["collections"] = ["*"]
        assert install(changed_manifest)["installed"] != changed["installed"]
        checks["changed_grant_new_install"] = True

        def op(collection, action="create"):
            return {"path": collection + "/rkey", "action": action, "cid": None, "private": "DENIED"}

        def event(seq, kind="commit", ops=None):
            return {"seq": seq, "type": kind, "time": "2026-10-06T00:00:00Z", "secret": "DENIED",
                    "evt": {"repo": "did:plc:fixture", "rev": "revision", "ops": ops or [op("app.bsky.feed.post")],
                            "blocks": {"$bytes": "DENIED"}, "blobs": ["DENIED"], "unrecognized": "DENIED"}}

        cases = [event(1), event(2, ops=[op("app.bsky.feed.like")]), event(3, "identity"),
                 event(4, "sync"), event(5, ops=[op("app.bsky.feed.post"), op("app.bsky.feed.like")]),
                 event(6, ops=[op("app.bsky.feed.post", "delete")]), event(7, "account")]
        # Direct requests bypass the Node supervisor. An echoing guest must see
        # only allowed metadata, even with a mixed CAR or extra unknown fields.
        requests = [{"id": e["seq"], "input": "event:" + json.dumps(e)} for e in cases]
        requests += [{"id": 8, "input": "echo:bypass"}, {"id": 9, "input": "event:{}"}]
        result = execute("--installation", installation,
                         input="".join(json.dumps(r) + "\n" for r in requests))
        assert result.returncode == 0, result.stderr
        rows = [json.loads(line) for line in result.stdout.splitlines()]
        assert rows[0]["installationId"] == original["receipt"]["installationId"]
        for row in rows[1:]:
            if row["id"] in [2, 3, 4, 7]:
                assert row["filtered"] and row["ok"] and row["peak_memory_bytes"] == 0 and row["logs"] == []
            elif row["id"] in [8, 9]:
                assert not row["ok"] and row["error"] == "invalid_request"
            else:
                assert row["ok"] and not row["filtered"], row
                assert "DENIED" not in row["result"] and "app.bsky.feed.like" not in row["result"]
                projected = json.loads(row["result"])
                assert len(projected["evt"]["ops"]) == 1
                assert set(projected["evt"]) == {"repo", "rev", "ops"}
        checks["host_filter_before_store_and_guest"] = True
        checks["mixed_commit_and_opaque_car_no_denied_bytes"] = True
        checks["delete_op_projected_and_direct_call_bypass_rejected"] = True
        # Tampering either file fails before readiness and leaves the receipt.
        for filename in ["plugin.wasm", "manifest.json", "receipt.json"]:
            path = Path(installation, filename)
            saved = path.read_bytes()
            path.write_bytes(saved + b"x")
            rejected = execute("--installation", installation)
            assert rejected.returncode != 0 and rejected.stdout == ""
            path.write_bytes(saved)
            checks[filename + "_tamper_rejected"] = True
        # Valid replacement bytes must also fail, not just corrupted inputs.
        for filename, replacement in [
            ("plugin.wasm", source.read_bytes()),
            ("manifest.json", json.dumps(changed_manifest).encode()),
        ]:
            path = Path(installation, filename)
            saved = path.read_bytes()
            path.write_bytes(replacement)
            rejected = execute("--installation", installation)
            assert rejected.returncode != 0 and rejected.stdout == ""
            path.write_bytes(saved)
            checks[filename + "_valid_replacement_requires_reinstall"] = True
        assert execute("--plugin", PLUGIN).returncode != 0
        checks["raw_plugin_requires_explicit_qualification_mode"] = True
        # Keep public evidence free of temporary paths; durable byte identity
        # and receipt schema survive teardown.
        report = {"recorded_at": datetime.now(timezone.utc).isoformat(),
                  "host_sha256": hashlib.sha256(HOST.read_bytes()).hexdigest(),
                  "receipts": [original["receipt"], changed["receipt"]],
                  "checks": checks, "runtime_responses": rows[1:], "startup_responses": startup_rows[1:]}
        (ROOT / "target/manifest-qualification.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
