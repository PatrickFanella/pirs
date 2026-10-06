# PDS hook points, draft 0

Status: working draft, 2026-10-02. Nothing here is stable. Section 8 lists what this repository has actually run.

This document proposes the points at which an AT Protocol PDS lets separately installed code observe or change its behaviour. It is written so that any PDS implementation can adopt it, not only the reference one.

## 1. Terms

- **PDS**: the server holding accounts, repositories and signing keys.
- **Plugin**: a package of sandboxed code plus a manifest declaring the hooks and capabilities it needs.
- **Host**: the process that loads plugins, enforces their limits and talks to the PDS.
- **Operator**: whoever runs the PDS and host and decides which plugins may be installed.
- **Account holder**: the person whose account a plugin acts for.

## 2. Rules

1. Plugin code does not run in the PDS process. The host is a separate process.
2. A plugin never receives signing keys, rotation keys, the PDS admin password or the account database.
3. A plugin has no ambient authority. Each capability is named in its manifest and granted by the operator, and where it concerns one account, by that account holder.
4. Where atproto already has a mechanism (the event stream, service proxying, service auth, OAuth scopes), the contract between PDS and host uses it. New PDS surface is added only where none exists.
5. Hooks are grouped into levels. An implementation states the highest level it supports, and a plugin states the lowest level it needs.

## 3. Levels

| Level | Name | What a plugin can do | PDS change needed |
| --- | --- | --- | --- |
| 0 | Observe | Receive commit, sync, identity and account events after they are persisted | None. `com.atproto.sync.subscribeRepos` is enough |
| 1 | Serve | Answer XRPC methods and HTTP routes | None for proxied XRPC. A route prefix or subdomain needs ingress or a PDS wrapper |
| 2 | Act | Read and write records and read blobs for an account that granted it | Open, see section 7 |
| 3 | Decide | Reject or rewrite a request before the PDS acts on it | Yes. The reference PDS has no such hook |

## 4. Hooks

"Seam" is where the reference PDS (`@atproto/pds` 0.5.36) exposes the behaviour today.

| Hook | Level | When | Can reject | Seam in the reference PDS |
| --- | --- | --- | --- | --- |
| `event.commit` | 0 | After a repo commit is sequenced | No | `ctx.sequencer` `events`, or `subscribeRepos` |
| `event.sync` | 0 | After a sync event | No | Same |
| `event.identity` | 0 | After a handle or DID change is sequenced | No | Same |
| `event.account` | 0 | After account status changes, including creation | No | Same |
| `xrpc.serve` | 1 | A client calls an NSID the plugin registered | n/a | `atproto-proxy` header to the host as a service |
| `http.serve` | 1 | A request arrives under the plugin's route | n/a | `PDS.run` `onCreated`, or ingress routing |
| `record.validate` | 3 | Before a record write is committed | Yes | None. Needs a patch in the four repo write handlers |
| `record.unique` | 3 | Before a create, to enforce a declared uniqueness rule | Yes | None. Hardcoded today for four `app.bsky` types |
| `account.create` | 3 | Before an account is created | Yes | None |
| `auth.session` | 3 | During sign-in and OAuth authorisation | Yes | OAuth provider hooks exist but the PDS does not pass them through |

Level 0 delivery is at least once, in sequence order, resumable from a cursor. A plugin that fails or is slow at level 0 or 1 never fails or delays a write.

## 5. Plugin interface

The owner selected WIT components on 2026-10-03 in [issue #6](https://git.subcult.tv/subculture-collective/pirs/issues/6). The [measured comparison and decision](../decisions/0001-plugin-interface.md) records the evidence: the tested Rust and Go WIT guests produced smaller artifacts and lower call time than their core JSON-over-pointer counterparts. Go WIT requires more author tooling and conversion steps.

Both interfaces exposed imports before instantiation. WIT also exposes the interface schema; a core import signature does not describe its JSON payload. The standalone spike verifies one synthetic event and host callback in each guest. It does not implement manifest grants or PDS event delivery.

Limits the host must enforce per plugin call: a memory ceiling, a wall-clock deadline, and bounds on response size and log volume. A fuel budget is optional; HappyView's source notes that fuel does not bound interpreters running inside a plugin, so a wall-clock deadline is required either way.

## 6. Capabilities

Proposed shape, following EmDash's registry RFC so that one manifest vocabulary can serve both: `category.operation` with constraints.

| Capability | Constraints |
| --- | --- |
| `events.subscribe` | event types, collections |
| `xrpc.serve` | NSIDs |
| `http.serve` | route prefix |
| `records.read`, `records.write` | collections |
| `blobs.read` | none yet |
| `network.request` | `allowedHosts` |
| `kv.read`, `kv.write` | size quota |

An unknown category or operation is rejected at install. Hooks at level 3 are capabilities too, and an operator can refuse them wholesale.

Publishing and discovery are out of scope for this draft. The intent is to extend EmDash's package and release records with a PDS-plugin release extension, not to define a second registry format.

## 7. Open questions

1. **Scope of installation.** Is a plugin installed per server by the operator, per account by its holder, or both? Levels 0 and 3 lean per server; level 2 leans per account.
2. **Per-account service identity.** `atproto-proxy` addresses a service by DID and service id. How a per-account plugin is addressed that way is unresolved.
3. **Acting for an account.** Level 2 could use OAuth permission sets issued to the host, or a narrower host-only grant. Neither is designed.
4. **Failure at level 3.** If a deciding plugin times out, failing open defeats a validation rule and failing closed lets a plugin take writes down. Proposed: the manifest declares one, and the operator can override it.
5. **Spaces.** Permissioned data adds per-space repositories and a separate sync path. Events and record capabilities for spaces are not covered.
6. **Ordering across hooks.** When several level 3 plugins claim the same hook, the order and the combination rule are undefined.

## 8. What has been run

- Level 0 and the `http.serve` seam, in process: `service/pirs/bridge.ts` attaches a status route in `onCreated` and a sequencer listener in `onStarted`. On 2026-10-03, `pnpm smoke` created an account and wrote a record through the public API against a loopback PLC creation/resolution fixture. The bridge observed account, identity, sync and commit events; the cursor advanced from 4 after account creation to 5 after the write. This replaces the synthetic identity-only check. [The account smoke qualification](../qualification/local-account-events.md) records commands and cleanup evidence.
- Gitea CI, 2026-10-03: the then-current identity-only smoke path passed on a hosted runner. A deliberately broken listener failed both push and PR jobs at the smoke assertion. [The qualification record](../qualification/ci-smoke.md) contains workflow-selection evidence and run links. This adds CI evidence for the existing seams, not another supported hook.

Standalone plugin interface spike, 2026-10-03: Rust and Go guests built and ran as both WIT components and core modules. Each guest made 153,000 verified synthetic event callbacks; imports were inspected before instantiation. The fresh hosted build and callback checks also passed in [run 12535](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12535). [The decision record](../decisions/0001-plugin-interface.md) contains sizes, timings, commands and the adopted WIT choice. This adds Wasm loading evidence in a separate executable, not PDS hook support.

Resumable level 0 delivery, 2026-10-04: an opt-in private Unix-socket bridge
served retained sequencer ranges to a separate consumer and WIT runtime.
The disposable account/record harness verified all 166 sequences in order,
host and PDS SIGKILL/restart recovery, bounded pages and request overload,
stopped-host write latency, exclusive cursor ownership, and replay after a
successful guest call interrupted before cursor persistence. Both public
event paths returned 404; the runtime environment was empty and its Linux
parent-death signal prevented an orphan after supervisor death.
[The delivery record](../qualification/event-delivery.md) contains limits,
commands and local measurements. This adds retained-event delivery evidence
for `event.commit`, `event.sync`, `event.identity` and `event.account`, not
manifest grants or production qualification.

Local manifest enforcement, 2026-10-05: the separate host rejected unknown
capabilities and uncovered component imports before instantiation, including a
startup callback/loop probe. Installed artifact and manifest hashes pin exact
bytes; corruption and valid replacement fail before readiness. Host filtering
removed denied event types, collections and opaque CAR data before guest delivery.
A disposable PDS produced a denied-collection write and a mixed-collection batch;
filtered progress and installed cursor identity survived restart.
[The manifest qualification](../qualification/manifest-install.md) records the
runtime tests, byte hashes and limits. This adds level 0 manifest enforcement
only; future capabilities remain unimplemented.

Outbound requests, 2026-10-06: the separately installed WIT guest used the
shipping resolver and TLS transport for two successful public HTTPS GETs,
with denied loopback DNS, private/metadata literals, unlisted hosts and a
non-HTTP URL between them. Undeclared imports failed before installation,
and raw mode granted no network access. Test-only transport fixtures exercised
private redirects, unknown-length oversized bodies, deadlines and redirect
limits without a shipping loopback exception.
[The network qualification](../qualification/network-request.md) records exact
bytes, the tested base and synthetic limits. This adds `network.request`
evidence for the local level 0 host; no webhook or hosted use is qualified.

Not yet run: a production plugin host, proxied XRPC to a host, and every level 2 and level 3 hook.

Standalone WIT sandbox host, 2026-10-03: a separate Wasmtime process passed
29 local calls covering traps, wall-clock interruption of an infinite loop and
an interpreter loop, memory exhaustion, encoded response/log quotas and invalid
input. Every failure was followed by a successful call in the same host PID.
The serving environment was empty after re-exec; a component requesting WASI
imports was rejected before readiness. [The host qualification](../qualification/plugin-host.md)
records the commands, raw observations and limits. This adds bounded standalone
call evidence; no PDS hook gains support.

Distribution evidence, 2026-10-03: the existing Dockerfile built on linux/amd64.
Its normal entrypoint exposed health and bridge status with the sequencer
listener attached. Loopback binding, a data-only mount and teardown were
verified. [The container record](../qualification/container.md) lists source
and image digests. No container account events or additional hook were tested.

Upstream rehearsal, 2026-10-03: distribution `v0.4.5037` (`@atproto/pds`
0.5.37) merged without conflicts. The real account/record smoke and both cleanup
checks passed locally with the same event counts and cursor advancement.
[The merge record](../upstream-merge.md) describes the seam inspection, timing
and hosted qualification. No additional hook was added.
