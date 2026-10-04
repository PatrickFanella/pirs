# Standalone WIT host qualification

The owner selected WIT components on 2026-10-03 after the comparison in
[PR #45](https://git.subcult.tv/subculture-collective/pirs/pulls/45).
[Issue #7](https://git.subcult.tv/subculture-collective/pirs/issues/7) adds a
separate Wasmtime host with call limits and recovery. The
[host README](../../service/pirs/host/README.md) records the CLI and byte quotas.

## Local evidence

On Kvant, Linux/amd64, Rust 1.95.0, Python 3.14.7 and Wasmtime 39.0.1:

```sh
cd service/pirs/host
rustup target add wasm32-wasip2
python3 build.py
python3 qualify.py
cd ../..
pnpm smoke
node --test pirs/smoke.test.ts
```

The locked release host and both fixtures built. `wasm-tools component wit`
showed that the accepted no_std fixture imported only
`pirs:sandbox/diagnostics@0.1.0`. The negative std fixture exported the same
`run(string) -> string` function and additionally imported WASI 0.2.6 interfaces.
It was rejected before readiness without executing a guest call.

The process harness made 29 requests to one serving PID with an 8 MiB linear
memory ceiling, a 250 ms deadline, a 1024-byte encoded result limit, a 256-byte
encoded log-array limit and a 512-byte input-line limit. It verified:

- A trap, an infinite Wasm loop, unbounded allocation and an interpreter's jump-to-self loop were contained. The two loops reported timeout; allocation reported memory_limit.
- Plain and escaped response floods reported response_limit. A string encoding to exactly 1024 bytes succeeded; the 1026-byte case failed.
- Repeated normal logs, empty logs and escaped logs reported log_limit. Every returned log array stayed within 256 encoded bytes.
- Malformed JSON, an oversized line and an unknown field reported invalid_request. The oversized line was drained before reading the next request.
- Every failure was followed by a successful echo in the same process. Fresh instances prevented failed guest state from carrying into the recovery call.
- Generated PDS environment markers were absent from `/proc/<pid>/environ` after the host re-exec. No operator-sentinel file descriptor was held; the disposable sentinel directory remained unchanged.
- EOF exited with status zero and no stderr guest output. All fixture processes were removed by the harness.

The checked-in [local results](plugin-host.measurements.json) retain the call
results and observed timings. This is a finite adversarial fixture exercise,
not an exhaustive Wasmtime or OS security assessment.

## Hosted check

`.gitea/workflows/host-sandbox.yaml` builds the locked workspace in a fresh
Rust 1.95.0 Debian container on Dozor, builds both fixtures, checks formatting
and runs the same process qualification. Hosted run links are recorded in the PR
after the checks finish. Local results do not establish hosted success.

## Boundary

This qualifies standalone component calls only. No PDS event is delivered to a
plugin; no manifest grant, account capability, XRPC proxy, deployment, level 2
hook or level 3 hook is qualified. The PDS does not launch the host or pass
secrets to it. Guest linear-memory limits do not cap native compilation/RSS,
and epoch deadlines have scheduling tolerance. OS user isolation and production
supervision remain operator/deployment work.
