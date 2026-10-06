#!/usr/bin/env python3
"""Build a configured reference component without adding guest capabilities."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text())
    assert set(config) == {"url", "key", "collections"}, "unknown/missing config fields"
    url = urlsplit(config["url"])
    assert url.scheme in {"http", "https"} and url.hostname and not url.username and not url.password
    assert not url.fragment and url.port in {None, 80, 443} and len(config["url"]) <= 2048
    host = url.hostname
    assert re.fullmatch(r"[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?", host), "exact lowercase DNS host required"
    assert re.fullmatch(r"[0-9a-f]{64}", config["key"]), "32-byte hex key required"
    collections = config["collections"]
    assert isinstance(collections, list) and 0 < len(collections) <= 32 and len(set(collections)) == len(collections)
    assert all(isinstance(c, str) and len(c) <= 317 and len(c.split('.')) >= 3 and
               all(re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]|[A-Za-z]", p) for p in c.split('.'))
               for c in collections), "exact collection NSIDs required"
    subprocess.run(["cargo", "build", "--locked", "--release", "--target", "wasm32-wasip2",
                    "-p", "pirs-commit-webhook"], cwd=ROOT,
                   env={**os.environ, "PIRS_WEBHOOK_CONFIG": str(config_path)}, check=True)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    plugin = args.output / "plugin.wasm"
    shutil.copyfile(ROOT / "target/wasm32-wasip2/release/pirs_commit_webhook.wasm", plugin)
    plugin.chmod(0o600)
    manifest = {"schemaVersion": 1, "id": "commit-webhook", "minSpecLevel": 0,
                "hooks": ["event.commit"], "capabilities": [
                    {"name": "events.subscribe", "constraints": {"eventTypes": ["commit"], "collections": collections}},
                    {"name": "network.request", "constraints": {"allowedHosts": [host]}}]}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Built reference plugin. Local delivery remains denied by production network policy.")


if __name__ == "__main__":
    main()
