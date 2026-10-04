#!/usr/bin/env python3
"""Build the locked host and both qualification fixtures."""
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent


def cargo(*arguments):
    subprocess.run(["cargo", "build", "--locked", "--release", *arguments], cwd=ROOT, check=True)


if __name__ == "__main__":
    cargo("-p", "pirs-plugin-host")
    cargo("--target", "wasm32-wasip2", "-p", "pirs-sandbox-fixture", "--features", "wasi")
    shutil.copyfile(ROOT / "target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm", ROOT / "target/forbidden-wasi.wasm")
    cargo("--target", "wasm32-wasip2", "-p", "pirs-sandbox-fixture")
