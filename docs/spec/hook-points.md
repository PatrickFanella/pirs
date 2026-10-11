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
| `http.serve` | exact routes, requestBytes, responseBytes, deadlineMs |
| `records.read`, `records.write` | collections |
| `blobs.read` | collections and a current visible owning record, see [public reads](public-read.md) |
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

The commit webhook reference adds a network-only WIT guest with a manifest
grant for `events.subscribe`, collection projection, HMAC-SHA256 notices and
at most three requests per event call. Native tests check signing, projection
and retry outcomes; installed-host qualification checks imports, filtering and
production localhost denial. [The reference record](../qualification/commit-webhook.md)
documents its build and limits. Issue #11's successful PDS-write-to-local-receiver
demo remains blocked by #10's private/loopback destination prohibition. This is
partial reference-plugin evidence, not the M1 exit demonstration.

Not yet run: a production plugin host and every level 2 and level 3 hook.

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

Patch carrier, 2026-10-06: a pinned fork package adds one optional trusted XRPC
transport adapter seam. Stock and patched Pirs account/record smoke and the
installed-manifest cursor/restart harness passed on merged #9 source. No
adapter is installed by default, and no deciding plugin hook gains support.
[The patch qualification](../qualification/pds-patches.md) records exact pins,
full-suite status and the unavailable natural next-release rebase gate.
Hosted stock and patched jobs on October 10 reached Kvant and Kuznya but
failed during upstream code generation before tests started. Kvant recorded
a job-container OOM kill. The wrapper now serializes the same workspace build
phases; pinned-pnpm phase checks, Bash syntax and ShellCheck pass. A repaired
hosted full-suite pass is still pending, and no hook gains evidence from this
wrapper change.

Quota-bound KV state, 2026-10-06: verified installed WIT components used
`kv.read` and `kv.write` in the separate host against disposable private state.
Quota rejection, two-plugin isolation, SIGKILL/restart durability, prefix lookup,
export and explicit uninstall deletion passed. The event consumer forwarded
the state root and acknowledged a durable guest write through a synthetic
sequencer and the shipping bridge/runtime. PDS smoke and full event regressions
also passed with their existing observer. [The KV qualification](../qualification/kv-storage.md)
records evidence and limits. Follow-up review fixes passed ordered parent-sync
fault injection and shipping operator recovery for malformed and reduced-quota
state, with six native and twenty KV/operator checks. No power-loss test was
performed. No additional PDS hook or production deployment is claimed.


Proxied plugin XRPC, 2026-10-06: a disposable account called an installed WIT
guest through the real PDS proxy handler with GET and JSON POST. The separate
HTTP supervisor verified service signatures, issuer keys, exact audiences,
method, expiry and nonce before invocation. The Rust runtime independently
refused undeclared NSIDs before guest allocation. Traps and guest limits
returned bounded XRPC errors, followed by successful calls in the same runtime.
[The service qualification](../qualification/xrpc-service.md) records the
local fixtures and deployment limits. [The per-server service contract](xrpc-service.md)
decides DID/service-ID addressing and documents the pinned PDS's explicit
bare-audience compatibility. Per-account addressing and installation remain
owner decisions. No production or complete level 1 conformance is claimed.

The 2026-10-06 NSID review correction accepts numeric intermediate authority
labels, refuses hyphens in method names and rejects reserved XRPC authorities
regardless of casing. Fresh native, installed-manifest, HTTP, runtime and
PDS-proxy checks passed alongside the shared event and KV regressions.
[The service qualification](../qualification/xrpc-service.md) records the
regression evidence. Exact method/collection matching and deployment gates
remain unchanged.

Public repository reads, 2026-10-06: installed WIT guests passed real record and
blob reads against stock PDS 0.5.37 and the selected pinned package. Exact
collection grants, local account status, current typed record references and
same-account blob availability constrain each read. Real self-deactivation,
account/record/blob takedowns and changes observed by the HTTP rechecks refused
guest delivery. The owner accepted HTTP observation semantics on 2026-10-06;
buffered final responses can deliver sampled data after a later takedown. The
three reproduced races are retained as qualification cases.
Result streams, operation count, invocation byte totals and deadlines were
bounded. [The public-read qualification](../qualification/public-read.md) records
the 38-call runs and direct stock API checks. [The contract](public-read.md)
describes the loopback transport and HTTP visibility observation limits. This
adds public auxiliary reads for existing hooks; private preferences, Spaces and
level 2 account consent remain outside the implementation. No hosted or production
qualification is claimed.

Plugin HTTP implementation for issue #14 uses a separate local listener per
installed component and a scriptless opaque HTML sandbox. It does not attach
plugin routes to the PDS router. [The origin decision](../decisions/0002-plugin-http-origin.md)
records the boundary; [the local qualification procedure](../qualification/plugin-http.md)
records the installed fixture and browser checks. The first browser run on
2026-10-06 blocked scripts, images, frames, refresh and forms, but did not cover
ordinary links. Independent review reproduced a credentialed session call when
a visitor clicked an installed guest link. That run did not qualify the full
navigation boundary.

The correction parses HTML with an HTML5 tree builder and emits inert semantic
markup without guest URLs, forms, styles, active tags or foreign trees. Ordinary
anchor labels remain visible but cannot navigate. Headings, lists, tables and
details controls remain rendered HTML. Native HTTP calls now apply installed
deadline and body-byte budgets before Store creation; CLI options may only
tighten those budgets. JSON ABI overhead is measured separately. A hard socket
lifetime covers incomplete headers as well as stalled bodies. Local parser,
installed HTTP and direct-native denial/recovery regressions passed on
2026-10-06. On 2026-10-10, browser conformance on source `c60e8d5` clicked the
installed component's ordinary, `_top`, new-window and encoded anchor elements
and inert form button. The page stayed on its plugin origin, no new tab opened,
and the disposable session counter remained at one total and one authenticated
baseline request. The marker remained `script did not run`, cookie inspection
threw the opaque-sandbox `SecurityError`, and the details control expanded while
headings, lists, emphasis and tables retained their semantics. The five HTTP
tests, HTTP type check, PDS smoke and two cleanup tests also passed. The
[qualification record](../qualification/plugin-http.md) and
[browser evidence](../qualification/plugin-http.browser.json) retain the source,
artifact identity and observations. The new HTTP CI step has not yet run hosted.
Public ingress, a real OAuth session and script-enabled HTML remain unqualified.

Repository-backed static site, 2026-10-10: source `22bc91a` installs a component
with only events, public record/blob reads and HTTP serving grants. A disposable
local account publishes an HTML index and plain-text about page. The installed
guest recognizes a real site commit, the event consumer advances its durable
cursor, and the same HTTP host serves the replacement blob without restarting.
The browser loads both versions at the same isolated URL and expands static
details; cookie access remains denied. Native, installed-site, HTTP and smoke
checks pass locally. Missing/deleted pages, disallowed content types, invalid
UTF-8 and oversized sources fail closed. This composes the existing level 0/1
hooks and public auxiliary reads, adding no new deciding hook. The
[site qualification](../qualification/static-site.md) records the clean-checkout
procedure and [browser evidence](../qualification/static-site.browser.json).
There is no cache, browser push refresh, binary asset serving or public ingress
qualification; reads retain the accepted HTTP observation semantics. Hosted CI
for the new site step remains pending.
