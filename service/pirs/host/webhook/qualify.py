#!/usr/bin/env python3
"""Reference checks and production localhost denial, never a delivery claim."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import tempfile
from receiver import verify

ROOT = Path(__file__).resolve().parent.parent
HOST = ROOT / "target/release/pirs-host"


def execute(*args, input=""):
    return subprocess.run([str(HOST), *map(str, args)], input=input, text=True,
                          capture_output=True, timeout=30)


def main():
    key = bytes([7] * 32)
    signature = "sha256=4da4763d6fd1753b5d62b8800346e2b6ceb547f16b34922a32b9f020acfa0f20"
    assert verify(key, b"notice", signature)
    assert not verify(key, b"notice\n", signature)
    assert not verify(bytes([8] * 32), b"notice", signature)
    assert not verify(key, b"notice", "sha256=bad")
    assert not verify(key, b"notice", "\u00ff" * 71)
    with tempfile.TemporaryDirectory(prefix="pirs-webhook-") as temporary:
        root = Path(temporary)
        config = root / "config.json"
        config.write_text(json.dumps({"url": "http://localhost/notice", "key": secrets.token_hex(32),
                                      "collections": ["app.bsky.feed.post"]}))
        config.chmod(0o600)
        output = root / "build"
        subprocess.run(["python3", str(ROOT / "webhook/build.py"), "--config", str(config),
                        "--output", str(output)], check=True)
        installed = execute("--plugin", output / "plugin.wasm", "--manifest", output / "manifest.json",
                            "--install-dir", root / "installs")
        assert installed.returncode == 0, installed.stderr
        receipt = json.loads(installed.stdout)
        assert receipt["receipt"]["imports"] == ["pirs:sandbox/network@0.1.0.request"]
        event = {"seq": 1, "type": "commit", "time": "now", "evt": {"repo": "did:plc:disposable",
                 "rev": "test-rev", "ops": [{"action": "create", "path": "app.bsky.feed.post/one"}]}}
        def line(value):
            return json.dumps({"id": value["seq"], "input": "event:" + json.dumps(value)}) + "\n"
        denied_event = {**event, "seq": 2, "evt": {**event["evt"], "ops": [
            {"action": "create", "path": "org.test.denied/two"}]}}
        account = {**event, "seq": 3, "type": "account"}
        result = execute("--installation", receipt["installed"], "--deadline-ms", "5000",
                         input=line(event) + line(denied_event) + line(account))
        assert result.returncode == 0, result.stderr
        rows = [json.loads(row) for row in result.stdout.splitlines()][1:]
        assert not rows[0]["ok"] and rows[0]["error"] == "trap", rows
        assert all(row["ok"] and row["filtered"] for row in rows[1:]), rows
        manifest = json.loads((output / "manifest.json").read_text())
        manifest["capabilities"].pop()
        (output / "manifest.json").write_text(json.dumps(manifest))
        refused = execute("--plugin", output / "plugin.wasm", "--manifest", output / "manifest.json",
                          "--install-dir", root / "refused")
        assert refused.returncode != 0 and not (root / "refused").exists()
        report = {"recorded_at": datetime.now(timezone.utc).isoformat(),
            "checks": {"cross_language_hmac_and_tamper": True, "network_only_import": True,
                       "production_localhost_delivery_denied": True, "collection_and_type_filtering": True,
                       "undeclared_network_rejected": True},
            "host_sha256": hashlib.sha256(HOST.read_bytes()).hexdigest(),
            "plugin_sha256": hashlib.sha256((output / "plugin.wasm").read_bytes()).hexdigest(),
            "receipt": receipt["receipt"], "runtime_responses": rows,
            "acceptance_gap": "No PDS-write-to-local-receiver delivery is possible under #10. No network override or third-party request was used."}
        (ROOT / "target/webhook-qualification.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
