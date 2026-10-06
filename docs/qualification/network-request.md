# Outbound request qualification, 2026-10-06

Issue #10 was qualified locally from merged-#9 base
`4b51dbf9a935a6a3773e26d87210ba931f92cc3f`. All implementation changes are in
`service/pirs` and `docs`. No upstream hook or #11 webhook was added.

## Commands and observed results

From `service/pirs/host`:

```sh
cargo fmt --all --check
python3 build.py
cargo test -p pirs-plugin-host --locked
python3 qualify.py
python3 qualify-manifest.py
python3 qualify-network.py
```

The locked host and four guest variants built. The three Rust tests passed.
They cover exact grants and invalid constraints, prohibited IPv4/IPv6 ranges,
mixed public/private DNS answers, callback capability denial and call quotas,
private literal and loopback-resolving redirect targets, unlisted redirect
hosts, oversized Content-Length and chunked bodies, a six-response redirect
loop, a delayed request deadline and successful transport recovery.

The deterministic transport tests use a fictional public hostname resolved
to a disposable local socket only by a `cfg(test)` resolver. They exercise
the production HTTP loop, redirects and quotas. They do not prove public
routing, DNS service behavior or TLS. The redirected private hostname uses
the shipping address classifier. No production policy is weakened, and the
shipping CLI has no resolver or transport override.

The shipping Wasmtime executable installed the WIT network guest into a
temporary content-addressed directory. Two credential-free HTTPS GETs to
`https://example.com/` returned status 200 and 577 body bytes in one process,
before and after five denied destinations. Final observed call times were
354.171335 and 146.981995 ms. The denied calls targeted `localhost`, which
resolved to `127.0.0.1` and `::1`, private and metadata literals, an unlisted
host and a file URL. An undeclared network import failed installation before
writing state. The same guest in raw qualification mode received
`network capability denied`. There was no inherited credential or PDS data
in the request. The guest used synthetic event envelopes, not a webhook.

The existing sandbox qualification passed 29 calls with recovery in one PID.
The manifest suite passed 32 checks, including startup/import ordering,
tampering, host filtering and denied WASI imports. Its reserved-capability
negative probe now uses `kv.read`, since network requests are implemented.

From `service`:

```sh
pnpm install --frozen-lockfile
pnpm smoke
pnpm check:events
node --test pirs/events/manifest.test.ts pirs/smoke.test.ts
pnpm qualify:events
```

Smoke created a disposable account and record, observed account, identity,
sync and commit events, and advanced cursor 4 to 5. Type checking passed.
The installed-consumer and two cleanup tests passed. Four bridge tests and
the full disposable PDS delivery harness passed, including the scoped writes,
restart/filter/acknowledgement checks and unchanged sentinel. An initial
consumer test ran before the host executable existed and failed with ENOENT;
it passed after the build. A preliminary Rust build used an unavailable
Reqwest builder method; source inspection corrected it before qualification.

## Exact byte evidence

| Artifact | SHA-256 |
| --- | --- |
| Release host | `5ffb97f517fecc191a6ad61808fe61239f4b3b7b302b8ea0c0de1418352ec7d0` |
| Network WIT guest | `31a7d48433b946c384b37f9013550a8177a90a06baf45cb88630521c987e2324` |
| Network report | `15985a2557835507a10895aaee54158edbb4c3d696e014f4e30f32e17308605a` |
| Sandbox report | `f37acb6b3b7d5c4757865cdbf73e0ad790a938d3073e3c3ce50eda2d2c4c4a4f` |
| Manifest report | `f6b51301ab9def89f0a551e0b8f52b8f9f7fa96483c94252913150a7fe05523d` |

Reports are generated under the ignored host `target` directory. The audit
preserves raw reports and command logs under `chunks/5/pirs10-logs`.

## Boundaries

This establishes local #10 acceptance on the stated base. Main advanced to
`e148dd6b65b8542213c178ccbfc8231e77af09ff` during this run. This branch keeps
the merged-#9 base and does not consume the #22 package change. The PR must
be reviewed against its live base before merge. Hosted CI is not claimed
passed, and no backlog waiver or cancellation was performed here.

The [implemented request policy](../spec/network-request.md) records limits,
conservative hostname/address restrictions and the bounded outstanding libc
DNS work. It does not install an OS sandbox. This work does not qualify a
webhook receiver or signatures, a production plugin, hosted deployment,
hostile load, level 1/2/3 hooks or any owner publication/release gate. #11 must
qualify its receiver without adding a private or loopback destination exception.
