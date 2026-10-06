#!/usr/bin/env python3
"""Installed WIT network qualification with the production resolver/transport."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import socket
import ipaddress
import tempfile

ROOT = Path(__file__).resolve().parent
HOST = ROOT / "target/release/pirs-host"
PLUGIN = ROOT / "target/network.wasm"


def execute(*args, input=""):
    return subprocess.run([str(HOST), *map(str, args)], input=input, text=True,
                          capture_output=True, timeout=30)


def event(url, seq=1):
    return json.dumps({"id": seq, "input": "event:" + json.dumps(
        {"seq": seq, "type": "commit", "time": "now", "evt": {"repo": url}},
        separators=(",", ":"))}) + "\n"


def main():
    checks = {}
    local_answers = sorted({row[4][0] for row in socket.getaddrinfo("localhost", 80, type=socket.SOCK_STREAM)})
    assert local_answers and all(ipaddress.ip_address(ip).is_loopback for ip in local_answers)
    with tempfile.TemporaryDirectory(prefix="pirs-network-") as temporary:
        root = Path(temporary)
        manifest = {"schemaVersion": 1, "id": "network-fixture", "minSpecLevel": 0,
                    "hooks": ["event.commit"], "capabilities": [
                        {"name": "diagnostics.log", "constraints": {}},
                        {"name": "events.subscribe", "constraints": {
                            "eventTypes": ["commit"], "collections": ["*"]}},
                        {"name": "network.request", "constraints": {
                            "allowedHosts": ["example.com", "localhost"]}}]}
        path = root / "manifest.json"
        path.write_text(json.dumps(manifest))
        installed = execute("--plugin", PLUGIN, "--manifest", path, "--install-dir", root / "installs")
        assert installed.returncode == 0, installed.stderr
        receipt = json.loads(installed.stdout)
        requests = "".join(event(url, i) for i, url in enumerate([
            "https://example.com/", "http://localhost/", "http://127.0.0.1/",
            "http://169.254.169.254/", "http://outside.example/", "file:///etc/passwd",
            "https://example.com/"], 1))
        result = execute("--installation", receipt["installed"], "--deadline-ms", "5000", input=requests)
        assert result.returncode == 0, result.stderr
        rows = [json.loads(line) for line in result.stdout.splitlines()][1:]
        for row in rows[1:6]:
            assert row["ok"] and row["result"].startswith("denied:"), row
        checks["production_transport_denies_local_dns_private_literal_metadata_outside_and_protocol"] = True
        # Public GETs contain no identities, credentials, account data or writes.
        # Record unavailable external access as a gate, never a synthetic pass.
        external = all(row["ok"] and row["result"].startswith("status:200 bytes:") for row in [rows[0], rows[-1]])
        checks["real_external_https_and_recovery"] = external
        manifest["capabilities"].pop()
        path.write_text(json.dumps(manifest))
        denied = execute("--plugin", PLUGIN, "--manifest", path, "--install-dir", root / "denied")
        assert denied.returncode != 0 and not denied.stdout and not (root / "denied").exists()
        checks["undeclared_network_import_rejected_before_install"] = True
        raw = execute("--qualification-only", "--plugin", PLUGIN, input=event("https://example.com/"))
        raw_row = json.loads(raw.stdout.splitlines()[1])
        assert raw_row["ok"] and raw_row["result"] == "denied:network capability denied", raw_row
        checks["raw_mode_does_not_grant_network"] = True
        report = {"recorded_at": datetime.now(timezone.utc).isoformat(),
                  "host_sha256": hashlib.sha256(HOST.read_bytes()).hexdigest(),
                  "plugin_sha256": hashlib.sha256(PLUGIN.read_bytes()).hexdigest(),
                  "receipt": receipt["receipt"], "localhost_answers": local_answers, "checks": checks, "runtime_responses": rows,
                  "external_gate": None if external else "Production HTTPS GET to example.com did not return 200. See responses."}
        (ROOT / "target/network-qualification.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        assert external, report["external_gate"]


if __name__ == "__main__":
    main()
