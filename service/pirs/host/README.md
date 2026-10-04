# WIT sandbox host

This is the standalone host for [issue #7](https://git.subcult.tv/subculture-collective/pirs/issues/7).
It loads one WIT component in a separate process and serves bounded test calls.
It has no PDS event connection, manifest grants or application capabilities.

## Build and qualify

Requires Rust 1.95.0, Python 3.11 or later, and Linux for the process inspection.
Wasmtime 39.0.1 and wit-bindgen 0.62.0 are pinned in the locked workspace.

```sh
cd service/pirs/host
rustup target add wasm32-wasip2
cargo fmt --all --check
python3 build.py
python3 qualify.py
```

The build creates the host, a no_std guest importing only diagnostics, and a
negative fixture with the same exported WIT call plus WASI imports. Qualification
rejects the negative fixture before readiness, then makes 29 requests to one
host PID. Traps, infinite loops, an allocating loop, an interpreter executing
a jump to itself, response/log floods and malformed requests each precede a
successful recovery call. Results go to the ignored `target/qualification.json`.
The fixture's allocator and canonical realloc export belong to this test guest;
they are not a plugin SDK.

## Process contract

```sh
target/release/pirs-host \
  --plugin target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm \
  --memory-mib 8 --deadline-ms 250 \
  --response-bytes 1024 --log-bytes 256 --input-bytes 512
```

The host clears every inherited environment variable through Unix re-exec
before loading the component. The serving process has no PDS configuration or
account database access API. The operator should launch it as a separate user
without PDS directory permissions or inherited secret file descriptors; this
implementation does not install an OS sandbox or change filesystem permissions.
Only `pirs:sandbox/diagnostics@0.1.0.log(string)` is linked. No WASI environment,
filesystem, networking or stream interface is available. An unlinked import or
incorrect WIT export prevents readiness.

Stdout starts with one JSON readiness line containing the interface and limits.
Stdin accepts JSON lines such as `{"id":1,"input":"echo:hello"}`. A success
response contains `id`, `ok:true`, `result`, `logs`, `log_bytes`,
`peak_memory_bytes` and `elapsed_ms`. Failure replaces `result` with one of
`trap`, `timeout`, `memory_limit`, `response_limit`, `log_limit` or
`invalid_request` in `error`. Guest error messages and backtraces are not emitted.
EOF exits successfully. Unknown request fields and oversized lines are rejected.

Each request gets a fresh Store and instance. Discarding them after the call
releases guest state and allows the next request after a failure. This is a
serial call contract with no persistent plugin state or delivery guarantee.

## Limits and their scope

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--memory-mib` | 16 | Guest linear memory; one memory, maximum configurable 64 MiB |
| `--deadline-ms` | 100 | Wall-clock deadline covering instantiation and the guest call |
| `--response-bytes` | 4096 | UTF-8 JSON encoding of the result string, including quotes and escapes |
| `--log-bytes` | 1024 | UTF-8 JSON encoding of the entire log array, including punctuation |
| `--input-bytes` | 16384 | Entire stdin request line, including newline |

Memory growth beyond the ceiling traps rather than returning a recoverable
allocation failure that a guest could ignore. Tables are also bounded at 4096
entries; the Store permits one memory, two tables and 16 core instances.
Artifact input is capped at 16 MiB. These are guest/runtime bounds; the linear
memory setting is not a ceiling on the native process's total RSS or compilation.

A host thread advances Wasmtime epochs every 5 ms. The callback compares the
absolute deadline rather than treating an epoch count as elapsed time. Diagnostics
and memory/table growth also check that deadline. Interruption depends on OS
scheduling; this is not a hard real-time guarantee. Qualification permits up to
750 ms for a configured 250 ms timeout and requires a response within one second.
Output transport backpressure is outside the plugin call deadline.

Quotas count encoded bytes, so control-character escaping and repeated empty
logs cannot bypass them. The response envelope adds bounded metadata to the
result and log quotas. A WIT string may be lifted into host memory before its
quota is checked, but its source remains bounded by the guest memory ceiling.

[The qualification record](../../../docs/qualification/plugin-host.md) states
what was run and the remaining integration boundaries.
