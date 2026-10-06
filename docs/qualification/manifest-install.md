# Local manifest installation qualification

Observed on 2026-10-05 in America/Chicago, 2026-10-06 UTC, against base
`0e0ec4f3839b3005a89c7cc13a6f6119c6fab807`. This run resumed the preserved issue #9
checkout and reran the built runtime. Earlier cancelled-task checkpoints were
not used as proof of acceptance.

## Commands and results

From `service/pirs/host`:

```sh
cargo fmt --all --check
python3 build.py
python3 qualify.py
python3 qualify-manifest.py
```

The locked build succeeded. Sandbox qualification passed all 29 requests,
including recovery after traps, startup/call deadlines, memory exhaustion,
encoded log/result quotas and malformed input. Manifest qualification passed
32 assertions covering honest/idempotent installation, unknown categories and
operations, undeclared and unsupported imports, malformed constraints, file
size ceilings, private permissions, checksum pinning and valid replacements.

The startup probe appends a core module to the built echo component. Its start
function calls the existing diagnostics import with `startup`, then loops.
Installation succeeds without executing that function. An allowed event logs
`startup` and times out at 100.96 ms with a 100 ms deadline, proving the
probe runs during instantiation. A denied event returns filtered with no logs
and zero guest memory. Adding an ungranted function import after the permitted
diagnostics import rejects installation before writing state or running start.

From `service/`:

```sh
node --test pirs/events/manifest.test.ts
pnpm check:events
pnpm qualify:events
pnpm smoke
node --test pirs/smoke.test.ts
```

The installed-consumer test passed durable filtered progress, no replay on
restart, changed-grant refusal, tamper refusal before readiness and preservation
of a legacy version 1 cursor. Event typechecking passed. The four existing
bridge tests passed. The disposable PDS harness retained its 166-event ordered
coverage, both SIGKILL/restart checks, replay after a call interrupted before
cursor persistence, cursor exclusivity, private transport, empty runtime
environment and parent-death cleanup.

An additional scoped observer replayed the disposable PDS and filtered sequences
1 through 4. A real write to `org.test.denied` at sequence 167 was filtered.
A mixed `app.bsky.feed.post` and `org.test.denied` batch at sequence 168 reached
the echoing guest through the Rust filter and advanced the synced cursor.
The direct hostile echo probes also verified that denied operation metadata,
CAR bytes, blobs, CIDs and unknown fields never reach a collection-scoped guest.
The extended harness initially raced the creation of its new cursor; polling
now retries only ENOENT, and the complete rerun passed.

Smoke created a disposable local account and record, observed all four event
types and moved the cursor from 4 to 5. The smoke cleanup tests passed.
The host CI workflow now runs manifest and installed-consumer qualification;
this record reports local results, not a hosted CI success.

## Byte identity

- Host executable SHA-256 `9d4327b9c72df257d39884053d0b83bf2631aed9b7fe14ad69352a309de6a2da`.
- Echo component SHA-256 `bb9bcf474100bc8b6785f3c9e6be1e7e831eb2e26188fa80a333599167e46fa5`.
- Sandbox component SHA-256 `82c88b15d542ac212e198476c2da4c9e062e9231a91a7758f11bdb1094bba7cc`.

Raw reports are produced in the ignored host target directory and copied to the
private audit workspace for review. Their hashes for this run are:

- `manifest-qualification.json` SHA-256 `c4aab86b0b6ecbd6544e84a061cb994f66def985d89f9105cdfe22213b3874d6`
- `qualification.json` SHA-256 `c958eebf8ca840c228e9c2fc99b706eb63bf6b03dc9e1e480f4d3dfc6242806a`
- `manifest-delivery.json` SHA-256 `9bc83940b15a775f72a8f1e85cc37d4e708b945afff77d7584eb3b297891c857`
- `event-delivery.json` SHA-256 `3b117532c78c15145fbe62e289584a1219b277e074f2211952acc509749f8d9d`

## Boundaries

Only local files, level 0 subscriptions and bounded diagnostics are implemented.
Known capabilities without an implementation fail installation. Collection-scoped
commits contain safe operation metadata, with opaque CAR data removed. Sync,
identity and account require an explicit wildcard collection grant. Upgrades
require a new installation identity and a reviewed new cursor path. Version 1
cursors fail without modification.

This is checksum pinning in a private operator-owned installation directory,
not publisher authentication or protection from an operator replacing the host
or forging all trusted installation state. No registry, lifecycle policy,
network capability, real identity or public deployment was qualified. The owner
gates and Spaces remain unresolved.
