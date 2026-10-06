# WIT sandbox host

This is the standalone host introduced in [issue #7](https://git.subcult.tv/subculture-collective/pirs/issues/7).
It loads one WIT component in a separate process and serves bounded test calls.
The separate [event consumer](../events/README.md) can deliver retained PDS
events through this call contract. Local file installs now enforce [manifest grants](../../../docs/spec/local-manifest.md).
Level 0 subscriptions, bounded diagnostics and manifest-granted HTTP requests are implemented.
Quota-bound [plugin state](../../../docs/spec/kv-storage.md) is implemented.
See [outbound request policy](../../../docs/spec/network-request.md).

## Build and qualify

Requires Rust 1.95.0, Python 3.11 or later, and Linux for the process inspection.
Wasmtime 39.0.1 and wit-bindgen 0.62.0 are pinned in the locked workspace.

```sh
cd service/pirs/host
rustup target add wasm32-wasip2
cargo fmt --all --check
python3 build.py
python3 qualify.py
python3 qualify-manifest.py
cargo test -p pirs-plugin-host --locked
python3 qualify-network.py
python3 qualify-kv.py
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
  --qualification-only --plugin target/wasm32-wasip2/release/pirs_sandbox_fixture.wasm \
  --memory-mib 8 --deadline-ms 250 \
  --response-bytes 1024 --log-bytes 256 --input-bytes 512
```

The host clears every inherited environment variable through Unix re-exec
before loading the component. The serving process has no PDS configuration or
account database access API. The operator should launch it as a separate user
without PDS directory permissions or inherited secret file descriptors; this
implementation does not install an OS sandbox or change filesystem permissions.
Diagnostics and the explicit `pirs:sandbox/network@0.1.0.request` import are linked.
The latter checks the installed grant on every call, including startup. Raw
qualification mode grants no network capability. No WASI environment, filesystem,
sockets, HTTP or stream interface is available. An unlinked import or
incorrect WIT export prevents readiness.

Stdout starts with one JSON readiness line containing the interface and limits.
Stdin accepts JSON lines such as `{"id":1,"input":"echo:hello"}`. A success
response contains `id`, `ok:true`, `result`, `logs`, `log_bytes`,
`peak_memory_bytes` and `elapsed_ms`. Failure replaces `result` with one of
`trap`, `timeout`, `memory_limit`, `response_limit`, `log_limit` or
`invalid_request` in `error`. Guest error messages and backtraces are not emitted.
EOF exits successfully. Unknown request fields and oversized lines are rejected.

Each request gets a fresh Store and instance. Discarding them after the call
releases guest state and allows the next request after a failure. KV-enabled installations persist state through explicit imports. This remains
a serial call contract without an exactly-once delivery guarantee.

## Limits and their scope

| Flag | Default | Meaning |
| --- | ---: | --- |
| `--memory-mib` | 16 | Guest linear memory; one memory, maximum configurable 64 MiB |
| `--deadline-ms` | 100 | Wall-clock deadline covering instantiation and the guest call |
| `--response-bytes` | 4096 | UTF-8 JSON encoding of the result string, including quotes and escapes |
| `--log-bytes` | 1024 | UTF-8 JSON encoding of the entire log array, including punctuation |
| `--input-bytes` | 16384 | Entire stdin request line, including newline; maximum 1 MiB |
| `--parent-pid` | absent | Optional Linux supervisor PID; SIGKILL when that parent dies |

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

Authenticated XRPC uses a separate [HTTP supervisor](../../../docs/spec/xrpc-service.md)
and an installed `xrpc.serve` grant. Run its disposable PDS proxy qualification
with `pnpm check:xrpc` and `pnpm qualify:xrpc` from `service/`.

Public reads use installed `records.read` and `blobs.read` imports and a fixed
`--public-pds http://127.0.0.1:PORT` origin. Both supervisors forward this option.
[The public-read contract](../../../docs/spec/public-read.md) describes account
visibility, current record ownership and the 64 KiB result bound. Build the
`public-read.wasm` fixture with `python3 build.py`, then run from `service/`:

```sh
pnpm exec tsc -p pirs/public-read/tsconfig.json
node --test pirs/public-read/public-read.test.ts
```

The test boots and removes a disposable PDS and two signed local PLC accounts.
To qualify an already installed stock package without changing dependency pins,
set `PIRS_READ_PDS_MODULE` to its absolute `dist/index.js` path. `PIRS_READ_REPORT`
selects an optional evidence JSON path. These options belong to the test harness;
the shipping host has no fixture override.
