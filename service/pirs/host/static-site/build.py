#!/usr/bin/env python3
"""Bind the reference site component to one public disposable account DID."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
COLLECTION = "tv.pirs.site.page"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--did", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"did:plc:[a-z2-7]{24}", args.did):
        parser.error("public PLC DID required")
    subprocess.run(["cargo", "build", "--locked", "--release", "--target", "wasm32-wasip2",
                    "-p", "pirs-static-site"], cwd=ROOT,
                   env={**os.environ, "PIRS_SITE_DID": args.did}, check=True)
    args.output.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(ROOT / "target/wasm32-wasip2/release/pirs_static_site.wasm", args.output / "plugin.wasm")
    manifest = {"schemaVersion": 1, "id": "static-site", "minSpecLevel": 1,
                "hooks": ["event.commit", "http.serve"], "capabilities": [
                    {"name": "events.subscribe", "constraints": {"eventTypes": ["commit"], "collections": [COLLECTION]}},
                    {"name": "records.read", "constraints": {"collections": [COLLECTION]}},
                    {"name": "blobs.read", "constraints": {"collections": [COLLECTION]}},
                    {"name": "http.serve", "constraints": {"routes": ["/", "/about"], "requestBytes": 128,
                      "responseBytes": 16384, "deadlineMs": 1000}}]}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

if __name__ == "__main__":
    main()
