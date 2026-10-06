# KV storage qualification, 2026-10-06

Base main was `0641cf7ed62d83c5f1afec3bd0dc598fba84189b`, including
PR50. Issue #9 and #10 were closed. Issue #16 had its original four
acceptance criteria and one stale dependency triage comment. No existing PR
covered KV state. Interrupted checkouts and PR51 were left untouched.

The isolated implementation built with the locked Rust workspace. Commands
ran from `service/pirs/host` unless stated otherwise:

- `python3 build.py` passed the release host and no-WASI KV component build.
- `cargo test -p pirs-plugin-host --locked` passed five tests. KV checks include
  exact encoded quota boundaries, quota exhaustion without replacing a value,
  key/prefix limits, 257-key listing refusal, denied callbacks and call limits,
  restart persistence, two-plugin isolation, export, deletion and lock exclusion.
- `python3 qualify-kv.py` passed eleven installed-runtime/operator checks.
  Both imported capabilities were checked before installation. Invalid and
  mismatched quotas failed. Startup required a separate state root. Two plugin
  IDs had isolated values. A rejected large replacement preserved the old
  value. An acknowledged write survived SIGKILL and restart. Export contained
  the exact state and refused overwrite. Uninstall required an explicit
  choice; export/retain/delete and standalone delete worked. A running host
  blocked another host and operator deletion. Raw mode denied both grants,
  and a symlinked state file failed startup without changing its target.
- `python3 qualify.py` passed the existing 29 sandbox calls.
- `python3 qualify-manifest.py` passed the existing 32 manifest checks.
- `python3 qualify-network.py` passed the unchanged shipping network policy,
  including public HTTPS, private-address refusal and denial in raw mode.
- From `service/`, `pnpm check:events` and both
  `node --test pirs/events/manifest.test.ts` and
  `node --test pirs/events/kv.test.ts` passed. The KV test exercised the
  production bridge, supervisor and installed host with a synthetic sequencer,
  and read the durable state file after the consumer acknowledged delivery.
- From `service/`, `pnpm smoke` passed a disposable PDS account and record
  write, advancing cursor 4 to 5. `pnpm qualify:events` passed four bridge tests
  and full PDS restart/replay/scoped runtime checks, final cursor 166 and scoped
  cursor 168. These are regressions; the real PDS event suite used its existing
  observer rather than the new KV guest.
- `cargo fmt --all --check` and `git diff --check` passed.

Release host SHA-256: `86fd84c032695ffe04a35588af5db0298c8dc903d47ffa162a932becbedc92e3`.
KV component SHA-256: `74e2b40fd8ee58160e84a45e6c958f43efd5a4d41a741c4e3ac0594253f9c475`.

## Review fixes

Review R1 found that recursive directory creation did not sync parent entries.
The host now creates each directory separately and syncs its parent before
opening state. This includes all auto-created root ancestors and the plugin
namespace. It also syncs existing entries, covering retry after a failed sync
or concurrent creation. The native regression records the ordered parent
paths, injects a failure at each sync boundary, checks that opening fails,
then retries with real directory syncs and completes a write. This is focused
fault-injection evidence, not a machine-crash or power-loss test.

Review R2 found that recovery commands loaded malformed or over-quota state.
Namespace validation and locking now precede a separate state load. Delete
and retain-uninstall do not load state. Export and guest startup still reject
invalid or oversized state. All commands still verify the installation and
hold the same namespace lock through completion.

After both fixes, the locked release/component build and six native tests
passed. `python3 qualify-kv.py` passed twenty checks, including each recovery
command with malformed state and with state above a newly installed reduced
quota. The checks also cover export failure preserving state and installation,
retain-uninstall lock exclusion, unverified-installation refusal, and namespace
and lock symlink refusal. The 29 sandbox calls, 32 manifest checks, network
qualification, event typecheck, both installed consumer tests and PDS smoke
passed again. Smoke advanced cursor 4 to 5. `pnpm qualify:events` also passed
the bridge and full PDS event regressions with the existing observer.

Fixed release host SHA-256:
`4f07324d2663d8ac469ce796701106a1b6bf4867e88290a2dd9bae5fe85e7a80`.
The KV component hash above is unchanged. Fix logs use the
`chunks/6/pirs16-fix-*` prefix in the audit workspace.

Full logs, live API snapshots, executable/source hashes and exact commit
heads are retained in the audit workspace `chunks/6/pirs16-*` files. The
committed qualification scripts reproduce the acceptance checks with temporary
state and generated/local fixtures. No production state, real identity or
public deployment was used. Hosted CI has not been claimed passed or waived.

This adds a bounded KV capability and explicit state choices on uninstall.
It does not complete lifecycle policy, the #11 local webhook owner decision,
#22 natural-next-release and stock level 1/2 gates, or any public/owner gate.
Filesystem sync remains subject to OS latency; committed writes do not roll
back after a later guest failure. Root owns review, merge, issue closure and
CI decisions. [The storage contract](../spec/kv-storage.md) records backup
scope and operational limits.
