#!/usr/bin/env python3
"""Exercise installed KV imports and operator commands in a disposable root."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
HOST = ROOT / "target/release/pirs-host"
GUEST = ROOT / "target/kv.wasm"
checks = []

def command(*args, success=True):
    result = subprocess.run([str(HOST), *map(str, args)], capture_output=True, text=True, timeout=15)
    assert (result.returncode == 0) == success, result.stderr
    return result

with tempfile.TemporaryDirectory(prefix="pirs-kv-") as temporary:
    root = Path(temporary)
    state = root / "host-state"
    def install(name, quota=128, capabilities=("kv.read", "kv.write")):
        manifest = {"schemaVersion": 1, "id": name, "minSpecLevel": 0,
                    "hooks": ["event.commit"], "capabilities": [
                        {"name": "events.subscribe", "constraints": {"eventTypes": ["commit"], "collections": ["*"]}},
                        *[{"name": c, "constraints": {"quotaBytes": quota}} for c in capabilities]]}
        path = root / (name + ".json")
        path.write_text(json.dumps(manifest))
        return command("--plugin", GUEST, "--manifest", path, "--install-dir", root / "installs")
    def start(installation, success=True, with_state=True):
        args = [str(HOST), "--installation", str(installation), "--deadline-ms", "500"]
        if with_state: args += ["--state-dir", str(state)]
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = child.stdout.readline()
        if success:
            assert json.loads(line)["ready"]
        else:
            assert not line and child.wait(timeout=10) != 0
        return child
    def call(child, action):
        event = {"seq": 1, "type": "commit", "time": "fixture", "evt": {"repo": action}}
        child.stdin.write(json.dumps({"id": 1, "input": "event:" + json.dumps(event, separators=(",", ":"))}) + "\n")
        child.stdin.flush()
        response = json.loads(child.stdout.readline())
        assert response["ok"], response
        return response["result"]
    def stop(child):
        child.stdin.close()
        assert child.wait(timeout=10) == 0, child.stderr.read()
    a = Path(json.loads(install("alpha").stdout)["installed"])
    b = Path(json.loads(install("beta").stdout)["installed"])
    # Both imported interfaces must have grants, before any instantiation.
    manifest = root / "denied.json"
    manifest.write_text(json.dumps({"schemaVersion":1,"id":"denied","minSpecLevel":0,"hooks":[],"capabilities":[{"name":"kv.read","constraints":{"quotaBytes":128}}]}))
    command("--plugin", GUEST, "--manifest", manifest, "--install-dir", root / "installs", success=False)
    checks.append("ungranted import rejected at install")
    for q in [0, 1, 64, 1048577, "128"]:
        payload = json.loads((root / "alpha.json").read_text())
        payload["capabilities"][1]["constraints"]["quotaBytes"] = q
        manifest.write_text(json.dumps(payload))
        command("--plugin", GUEST, "--manifest", manifest, "--install-dir", root / "installs", success=False)
    checks.append("invalid and mismatched quotas rejected")
    start(a, success=False, with_state=False)
    checks.append("KV startup requires separate state root")
    ca, cb = start(a), start(b)
    assert call(ca, "write") == "Ok(())"
    assert call(cb, "read") == "Ok(None)"
    assert call(ca, "read") == "Ok(Some([1, 2, 3]))"
    assert 'entry' in call(ca, "list")
    assert call(ca, "flood").startswith("Err(")
    assert call(ca, "read") == "Ok(Some([1, 2, 3]))"
    checks.append("installed imports enforce isolation, lookup, prefix list and atomic quota rejection")
    start(a, success=False)
    command("--installation", a, "--state-dir", state, "--state-command", "delete", success=False)
    checks.append("running namespace rejects another host and operator deletion")
    ca.kill()
    assert ca.wait(timeout=10) == -9
    stop(cb)
    ca = start(a)
    assert call(ca, "read") == "Ok(Some([1, 2, 3]))"
    stop(ca)
    checks.append("state survives SIGKILL after acknowledged write")
    export = root / "alpha-export.json"
    command("--installation", a, "--state-dir", state, "--state-command", "export", "--export-path", export)
    assert json.loads(export.read_text()) == {"entry": [1, 2, 3]}
    command("--installation", a, "--state-dir", state, "--state-command", "export", "--export-path", export, success=False)
    command("--installation", a, "--state-dir", state, "--state-command", "uninstall", success=False)
    assert a.exists()
    command("--installation", a, "--state-dir", state, "--state-command", "uninstall", "--state-action", "export", "--export-path", root / "uninstall-export.json")
    assert not a.exists() and (state / "alpha/state.json").exists()
    assert json.loads((root / "uninstall-export.json").read_text()) == {"entry": [1, 2, 3]}
    checks.append("export is exact, never overwrites, and uninstall requires an explicit choice")
    a = Path(json.loads(install("alpha").stdout)["installed"])
    ca = start(a)
    assert call(ca, "read") == "Ok(Some([1, 2, 3]))"
    assert call(ca, "delete") == "Ok(())"
    assert call(ca, "read") == "Ok(None)"
    stop(ca)
    command("--installation", a, "--state-dir", state, "--state-command", "uninstall", "--state-action", "delete")
    assert not a.exists() and not (state / "alpha").exists() and b.exists()
    checks.append("key deletion and uninstall state deletion leave the other plugin intact")
    command("--installation", b, "--state-dir", state, "--state-command", "uninstall", "--state-action", "retain")
    assert not b.exists() and (state / "beta").exists()
    b = Path(json.loads(install("beta").stdout)["installed"])
    command("--installation", b, "--state-dir", state, "--state-command", "delete")
    cb = start(b)
    assert call(cb, "read") == "Ok(None)"
    stop(cb)
    checks.append("retain uninstall and standalone state deletion")
    # Recovery must use verified installations and the shipping CLI, even when
    # state cannot be loaded. Reduce a grant by installing a new verified version.
    for kind in ("corrupt", "reduced"):
        for action in ("delete", "uninstall-delete", "uninstall-retain"):
            name = kind + "-" + action
            installation = Path(json.loads(install(name).stdout)["installed"])
            child = start(installation)
            assert call(child, "write") == "Ok(())"
            stop(child)
            saved = state / name / "state.json"
            if kind == "corrupt":
                saved.write_text("{broken")
            else:
                installation = Path(json.loads(install(name, quota=8).stdout)["installed"])
            before = saved.read_bytes()
            start(installation, success=False)
            command("--installation", installation, "--state-dir", state,
                    "--state-command", "export", "--export-path", root / (name + "-export.json"), success=False)
            assert installation.exists() and saved.read_bytes() == before
            args = ["--installation", installation, "--state-dir", state, "--state-command"]
            if action == "delete":
                command(*args, "delete")
                assert installation.exists() and not saved.parent.exists()
                child = start(installation)
                assert call(child, "read") == "Ok(None)"
                stop(child)
            else:
                choice = action.removeprefix("uninstall-")
                command(*args, "uninstall", "--state-action", choice)
                assert not installation.exists()
                if choice == "retain":
                    assert saved.read_bytes() == before
                else:
                    assert not saved.parent.exists()
            checks.append(kind + " state recovery through " + action)
    # Retain must still exclude a running host without consuming its state.
    child = start(b)
    command("--installation", b, "--state-dir", state, "--state-command", "uninstall",
            "--state-action", "retain", success=False)
    assert b.exists()
    stop(child)
    checks.append("retain uninstall respects namespace lock")
    # Non-consuming recovery still verifies installation receipts and rejects
    # namespace/lock symlinks before touching state or removing installations.
    invalid = Path(json.loads(install("invalid-recovery").stdout)["installed"])
    invalid_state = state / "invalid-recovery"
    invalid_state.mkdir()
    (invalid_state / "state.json").write_text("{broken")
    receipt = invalid / "receipt.json"
    original_receipt = receipt.read_bytes()
    receipt.write_text("{}")
    for choice in ("delete", "retain"):
        command("--installation", invalid, "--state-dir", state, "--state-command", "uninstall",
                "--state-action", choice, success=False)
        assert invalid.exists() and (invalid_state / "state.json").read_text() == "{broken"
    receipt.write_bytes(original_receipt)
    checks.append("recovery refuses unverified installations")
    outside = root / "outside-state"
    outside.mkdir()
    sentinel = outside / "sentinel"
    sentinel.write_text("preserved")
    link_install = Path(json.loads(install("linked-recovery").stdout)["installed"])
    (state / "linked-recovery").symlink_to(outside, target_is_directory=True)
    command("--installation", link_install, "--state-dir", state, "--state-command", "delete", success=False)
    assert sentinel.read_text() == "preserved" and link_install.exists()
    (state / "linked-recovery").unlink()
    (state / ".linked-recovery.lock").unlink()
    (state / ".linked-recovery.lock").symlink_to(sentinel)
    command("--installation", link_install, "--state-dir", state, "--state-command", "uninstall",
            "--state-action", "retain", success=False)
    assert sentinel.read_text() == "preserved" and link_install.exists()
    checks.append("recovery rejects namespace and lock symlinks")
    raw = subprocess.Popen([str(HOST), "--qualification-only", "--plugin", str(GUEST)],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert json.loads(raw.stdout.readline())["ready"]
    assert call(raw, "write").startswith("Err(")
    assert call(raw, "read").startswith("Err(")
    stop(raw)
    checks.append("raw mode denies both KV capabilities")
    # Operators cannot redirect state.json through a symlink.
    (state / "beta/state.json").symlink_to(export)
    start(b, success=False)
    assert json.loads(export.read_text()) == {"entry": [1, 2, 3]}
    checks.append("state file symlink rejected")

report = {"checks": checks, "passed": len(checks), "scope": "installed production runtime and operator commands; disposable state, no PDS or hosted CI"}
(ROOT / "target/kv-qualification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
