#!/usr/bin/env python3
"""Build throwaway guests; keep all outputs inside this spike directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"
ARTIFACTS = ROOT / "artifacts"
WASM_TOOLS_VERSION = "1.261.0"
WIT_BINDGEN_VERSION = "0.62.0"
ADAPTER_VERSION = "49.0.2"
CHECKSUMS = {
    "wasm-tools-1.261.0-x86_64-linux.tar.gz": "ad62b2176037e93e1348cb65d6212d128ca9f097b63d155569f25215818ff7b1",
    "wit-bindgen-0.62.0-x86_64-linux.tar.gz": "3e81cc6523729f7532b4aa7968648a04abf0c711b7d1677150e9121f4e6458fe",
    "wasi_snapshot_preview1.reactor.wasm": "90b99ee01bfdb8f128bed56240f43a60ae5b016151f2f0c94bc4814a62f17d50",
}


def verify(path):
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != CHECKSUMS[path.name]:
        raise ValueError(f"checksum mismatch: {path.name}")


def extract_tools(archive):
    # Debian's Python 3.11.2 lacks tarfile's later data filter. Only the pinned
    # archive's directories and regular files are needed; reject links/devices
    # and traversal explicitly rather than using unrestricted extractall.
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            destination = (TOOLS / member.name).resolve()
            if not destination.is_relative_to(TOOLS.resolve()):
                raise ValueError(f"archive path escapes tools: {member.name}")
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)
                destination.chmod(member.mode & 0o777)
            else:
                raise ValueError(f"unsupported archive entry: {member.name}")


def run(args, cwd=ROOT, env=None):
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def bootstrap():
    TOOLS.mkdir(exist_ok=True)
    for name, version in [("wasm-tools", WASM_TOOLS_VERSION), ("wit-bindgen", WIT_BINDGEN_VERSION)]:
        filename = f"{name}-{version}-x86_64-linux.tar.gz"
        archive = TOOLS / filename
        if not archive.exists():
            urllib.request.urlretrieve(
                f"https://github.com/bytecodealliance/{name}/releases/download/v{version}/{filename}", archive)
        verify(archive)
        extract_tools(archive)
    adapter = TOOLS / "wasi_snapshot_preview1.reactor.wasm"
    if not adapter.exists():
        urllib.request.urlretrieve(
            f"https://github.com/bytecodealliance/wasmtime/releases/download/v{ADAPTER_VERSION}/{adapter.name}", adapter)
    verify(adapter)
    run(["rustup", "target", "add", "wasm32-unknown-unknown", "wasm32-wasip2"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true")
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.bootstrap:
        bootstrap()
    ARTIFACTS.mkdir(exist_ok=True)
    wasm_tools = TOOLS / f"wasm-tools-{WASM_TOOLS_VERSION}-x86_64-linux/wasm-tools"
    wit_bindgen = TOOLS / f"wit-bindgen-{WIT_BINDGEN_VERSION}-x86_64-linux/wit-bindgen"
    build_env = dict(os.environ, GOOS="wasip1", GOARCH="wasm", GOTOOLCHAIN="local")
    for package, target, name in [
        ("spike-rust-core", "wasm32-unknown-unknown", "rust-core"),
        ("spike-rust-component", "wasm32-wasip2", "rust-component"),
    ]:
        run(["cargo", "build", "--locked", "--release", "-p", package, "--target", target])
        shutil.copyfile(ROOT / "target" / target / "release" / (package.replace("-", "_") + ".wasm"), ARTIFACTS / f"{name}.wasm")
    run(["go", "build", "-buildmode=c-shared", "-trimpath", "-ldflags=-s -w", "-o", ARTIFACTS / "go-core.wasm", "."], ROOT / "go-core", build_env)
    generated = ROOT / "go-component/generated"
    run([wit_bindgen, "go", "--world", "plugin", "--out-dir", generated, "world.wit"])
    (generated / "export_wit_world").mkdir(exist_ok=True)
    shutil.copyfile(ROOT / "go-component/on_event.go", generated / "export_wit_world/on_event.go")
    # Generated dependency versions are pinned by the generator. Retain sums in source.
    if (ROOT / "go-component/go.sum").exists():
        shutil.copyfile(ROOT / "go-component/go.sum", generated / "go.sum")
    run(["go", "mod", "tidy"], generated, build_env)
    shutil.copyfile(generated / "go.sum", ROOT / "go-component/go.sum")
    run(["go", "build", "-buildmode=c-shared", "-trimpath", "-ldflags=-s -w -checklinkname=0", "-o", ARTIFACTS / "go-component-core.wasm", "."], generated, build_env)
    run([wasm_tools, "component", "embed", "--world", "plugin", "world.wit", ARTIFACTS / "go-component-core.wasm", "-o", ARTIFACTS / "go-component-embedded.wasm"])
    run([wasm_tools, "component", "new", "--adapt", TOOLS / "wasi_snapshot_preview1.reactor.wasm", ARTIFACTS / "go-component-embedded.wasm", "-o", ARTIFACTS / "go-component.wasm"])
    for name in ["rust-core", "rust-component", "go-core", "go-component"]:
        run([wasm_tools, "validate", ARTIFACTS / f"{name}.wasm"])
    run(["cargo", "build", "--locked", "--release", "-p", "spike-host"])
    artifacts = {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                 for p in sorted(ARTIFACTS.glob("*.wasm"))}
    (ARTIFACTS / "hashes.json").write_text(json.dumps(artifacts, indent=2) + "\n")


if __name__ == "__main__":
    main()
