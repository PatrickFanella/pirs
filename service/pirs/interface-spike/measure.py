#!/usr/bin/env python3
"""Keep raw local timings and import metadata; no performance threshold in CI."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess

ROOT = Path(__file__).resolve().parent
NAMES = ["rust-core", "rust-component", "go-core", "go-component"]


def version(*command):
    return subprocess.check_output(command, text=True).strip()


def main():
    runs = []
    for index in range(3):
        # Rotate the execution order to expose some warm-cache/order effects.
        names = NAMES[index:] + NAMES[:index]
        output = subprocess.check_output(
            [ROOT / "target/release/spike-host", *[f"artifacts/{name}.wasm" for name in names]],
            cwd=ROOT, text=True)
        run = [json.loads(line) for line in output.splitlines()]
        assert len(run) == 4
        for result in run:
            assert result["verified_host_calls"] == 51_000
            assert result["imports"]
            assert len(result["instantiate_us"]) == 25
            assert len(result["call_us"]) == 5
        runs.append(run)
    summary = {}
    for name in NAMES:
        samples = [r for run in runs for r in run if r["artifact"] == f"artifacts/{name}.wasm"]
        path = ROOT / f"artifacts/{name}.wasm"
        summary[name] = {
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "compile_us_median": statistics.median(r["compile_us"] for r in samples),
            "instantiate_us_median": statistics.median(t for r in samples for t in r["instantiate_us"]),
            "call_us_median": statistics.median(t for r in samples for t in r["call_us"]),
            "call_us_min": min(t for r in samples for t in r["call_us"]),
            "call_us_max": max(t for r in samples for t in r["call_us"]),
            "imports": samples[0]["imports"],
        }
    evidence = {
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "rust": version("rustc", "--version"),
        "go": version("go", "version"),
        "wasmtime": "39.0.1 (Cargo.lock)",
        "warmup_calls": 1000,
        "calls_per_batch": 10000,
        "batches_per_process": 5,
        "processes": 3,
        "instantiations_per_process": 25,
        "summary": summary,
        "runs": runs,
    }
    destination = ROOT / "artifacts/measurements.json"
    destination.write_text(json.dumps(evidence, indent=2) + "\n")
    for name, result in summary.items():
        print(name, json.dumps({k: v for k, v in result.items() if k != "imports"}))
    print("PASS: four guests; each made 153000 verified host calls; imports inspected before instantiation")
    print(destination)


if __name__ == "__main__":
    main()
