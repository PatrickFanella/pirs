#!/usr/bin/env python3
"""Exercise hostile WIT calls in one disposable host process, then recover."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import selectors
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent


def wire(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", type=Path, default=ROOT / "target/release/pirs-host")
    parser.add_argument("--plugin", type=Path, default=ROOT / "target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm")
    parser.add_argument("--forbidden-plugin", type=Path, default=ROOT / "target/forbidden-wasi.wasm")
    options = parser.parse_args()
    assert options.forbidden_plugin.read_bytes()[:8] == b"\0asm\x0d\0\x01\0", "negative fixture is not a component"
    rejected = subprocess.run([str(options.host.resolve()), "--plugin", str(options.forbidden_plugin.resolve())],
                              input=b"", capture_output=True, timeout=30)
    assert rejected.returncode != 0 and rejected.stdout == b"", "ungranted WASI component became ready"
    assert rejected.stderr == b"Error: plugin load or sandbox contract check failed\n", rejected.stderr
    rows = []
    with tempfile.TemporaryDirectory(prefix="pirs-host-qualification-") as temporary:
        sentinel = Path(temporary) / "operator-sentinel"
        sentinel.write_text("qualification only; no PDS database")
        environment = dict(os.environ, PDS_DATA_DIRECTORY=temporary,
                           PDS_ADMIN_PASSWORD="disposable-qualification-marker",
                           PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX="not-a-key",
                           PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX="not-a-key")
        process = subprocess.Popen([
            str(options.host.resolve()), "--plugin", str(options.plugin.resolve()),
            "--memory-mib", "8", "--deadline-ms", "250",
            "--response-bytes", "1024", "--log-bytes", "256", "--input-bytes", "512",
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=environment, bufsize=0)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        buffered = bytearray()

        def receive(timeout=2):
            deadline = time.monotonic() + timeout
            while b"\n" not in buffered:
                assert selector.select(max(0, deadline - time.monotonic())), "host response deadline"
                chunk = os.read(process.stdout.fileno(), 4096)
                assert chunk, "host exited before responding"
                buffered.extend(chunk)
                assert len(buffered) < 4096, "response envelope exceeded qualification bound"
            line, _, rest = buffered.partition(b"\n")
            buffered[:] = rest
            return json.loads(line)

        def call(command=None, expected=None, raw=None):
            request_id = len(rows) + 1
            started = time.monotonic()
            process.stdin.write(raw if raw is not None else wire({"id": request_id, "input": command}) + b"\n")
            result = receive()
            elapsed = (time.monotonic() - started) * 1000
            assert process.poll() is None, "serving process died"
            assert result["log_bytes"] == len(wire(result["logs"])), result
            assert result["log_bytes"] <= 256, result
            assert result["peak_memory_bytes"] <= 8 * 1024 * 1024, result
            if expected:
                assert result["ok"] is False and result["error"] == expected, result
                assert "result" not in result, result
            else:
                assert result["ok"] is True, result
                assert len(wire(result["result"])) <= 1024, result
                if command.startswith("echo:"):
                    assert result["result"] == command[5:], result
            if raw is None:
                assert result["id"] == request_id, result
            assert elapsed < 1000, (command, elapsed)
            if expected == "timeout":
                assert 250 <= result["elapsed_ms"] < 750, result
            rows.append({"case": command if raw is None else command,
                         "error": result.get("error"), "elapsed_ms": round(result["elapsed_ms"], 3),
                         "peak_memory_bytes": result["peak_memory_bytes"],
                         "log_bytes": result["log_bytes"]})
            return result

        try:
            ready = receive(30)
            assert ready["ready"] and ready["interface"] == "pirs:sandbox@0.1.0", ready
            assert ready["limits"] == {"memory_bytes": 8388608, "deadline_ms": 250,
                                       "response_bytes": 1024, "log_bytes": 256, "input_bytes": 512}, ready
            # Inspect the serving PID after its env-clearing exec, before any guest call.
            assert Path(f"/proc/{process.pid}/environ").read_bytes() == b"", "host inherited environment"
            descriptors = list(Path(f"/proc/{process.pid}/fd").iterdir())
            assert not any(temporary in os.readlink(fd) for fd in descriptors), "host holds operator file"
            call("echo:ready")
            failures = [("trap", "trap"), ("loop", "timeout"), ("allocate", "memory_limit"),
                        ("interpreter", "timeout"), ("response-flood", "response_limit"),
                        ("escaped-response", "response_limit"),
                        ("over-boundary-response", "response_limit"), ("log-flood", "log_limit"),
                        ("empty-log-flood", "log_limit"), ("escaped-log", "log_limit")]
            for command, expected in failures:
                call(command, expected)
                call("echo:recovered-after-" + command)
            boundary = call("boundary-response")
            assert len(wire(boundary["result"])) == 1024, boundary
            call("unicode-雪-🦀")
            call("malformed-json", "invalid_request", b"{invalid}\n")
            call("echo:recovered-after-malformed")
            call("oversized-line", "invalid_request", b"x" * 8192 + b"\n")
            call("echo:recovered-after-oversized")
            call("unknown-field", "invalid_request", b'{"input":"ok","extra":true}\n')
            call("echo:recovered-after-unknown-field")
            assert sentinel.read_text() == "qualification only; no PDS database"
            assert list(Path(temporary).iterdir()) == [sentinel]
            process.stdin.close()
            assert process.wait(timeout=5) == 0
            assert process.stderr.read() == b"", "host wrote unbounded guest errors to stderr"
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()
        report = {"interface": "pirs:sandbox@0.1.0", "recorded_at": datetime.now(timezone.utc).isoformat(),
                  "platform": platform.platform(), "limits": ready["limits"],
                  "artifact_sha256": {"host": hashlib.sha256(options.host.read_bytes()).hexdigest(),
                                      "plugin": hashlib.sha256(options.plugin.read_bytes()).hexdigest(),
                                      "forbidden_plugin": hashlib.sha256(options.forbidden_plugin.read_bytes()).hexdigest()},
                  "calls": len(rows), "ungranted_wasi_rejected": True,
                  "environment_empty": True, "operator_sentinel_unchanged": True, "cases": rows}
        destination = ROOT / "target/qualification.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
