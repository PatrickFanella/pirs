# PDS patch qualification

Issue [#22](https://git.subcult.tv/subculture-collective/pirs/issues/22) remains
open. The integration starts from Pirs main
`4b51dbf9a935a6a3773e26d87210ba931f92cc3f`, including #9's installed-manifest
consumer and cursor version 2. The cancelled checkout was preserved; only
its package patch, build tools and workflow were imported.

The fork keeps upstream `@atproto/pds@0.5.37` at
`a7c8604d876a200a1e4fa4aec83d4189ac4f1c12` as an ancestor. Its patch head is
`39ec3487005b033e71b554d704c3cd40995d8082` and tree is
`4332a1d68afc7aebc633fb5f98b8acdae4c32a1d`. The exported patch exactly
reproduces that tree. Package and patch SHA-256 pins live in
`service/pirs/pds-patches/pins.json`, alongside both frozen consumer locks.

## Local checks, October 6, 2026

Node 24.21.0, consumer pnpm 10.34.1 and upstream pnpm 11.11.0 on Sputnik.
All accounts, PLC documents, keys, data directories and test infrastructure
were disposable. No public identity or production PDS was used.

- PDS package build and the focused hook test passed, 3 tests. The cases cover
  omitted/empty adapters, stock health/unknown/authentication responses,
  ordered adapters, short-circuit rejection, CORS, error handling and recovery.
- The retained old test log had a failure. `describeServer` is a basic route
  before the adapter seam. The corrected test uses `getSession`, which reaches
  the XRPC router. No passing claim is based on that old log.
- Stock and patched Pirs smoke passed. Both observed commit 2, sync 1,
  identity 1 and account 1; the cursor advanced from 4 to 5.
- Cleanup 2, bridge 4 and installed consumer 1 passed on stock. Patched cleanup
  and bridge passed, then the installed consumer passed after its fresh host
  build. An early consumer test ran before the host existed and failed ENOENT;
  its rerun used the newly built host and passed.
- `pnpm check:events` passed on patched. Both event-delivery harnesses passed
  all 166 original sequences and scoped writes 167/168, cursor version 2,
  filtering, process restart, runtime failure and acknowledgement-boundary
  replay. The installed host was built from merged main source.
- Two normalized packs matched byte for byte. The original raw packs differed
  only in dependency key order in package.json, with equal parsed metadata.
- Formatting, lint and exported-tree identity checks passed.

The package built from the release tag resolves workspace dependencies to that
tag's versions. Both frozen PDS graphs include `@atproto/lex` 0.3.14 and
`@atproto/repo` 0.11.0. Every dependency snapshot is identical after renaming
the PDS package key; only the PDS artifact resolution changes.
The artifact filename includes the fork commit prefix so replacing a package
cannot silently retain the earlier file dependency graph. Final patched smoke
and consumer qualification use the freshly resolved frozen graph.

The full upstream suites passed against new independent disposable databases:

- Patched: 54 suites, 454 passed tests, 1 upstream skip, 31 passed snapshots,
  283.320 seconds.
- Stock: 53 suites, 451 passed tests, 1 upstream skip, 31 passed snapshots,
  284.046 seconds.

The extra patched suite is the three hook tests. Commands used
`pnpm exec jest --maxWorkers=1 --workerIdleMemoryLimit=512MB --json` from each
PDS package, with `NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=8192"`
and separate disposable Postgres database URLs and Redis instances. Raw reports
are retained in the audit workspace's `chunks/4/pirs22-{stock,patched}-upstream.json`.

The first
patched single-process run exhausted the default 4 GB heap before reporting;
that is a failed attempt. An intervening worker rerun hit stale database rows
left by the aborted attempt and was stopped. Both final runs used new databases
and passed. Workers use an 8 GB heap and recycle at 512 MB. No runtime acceptance
is waived. The new hosted stock/patched matrix is configured but has not yet
passed on this integration revision.

## Hosted build failure, October 10, 2026

Revision `80b024281fd84c9c41531fbdc069f787feeb0c06` reached both online CI
runners. Runs [14201](https://git.subcult.tv/subculture-collective/pirs/actions/runs/14201)
on Kuznya and [14202](https://git.subcult.tv/subculture-collective/pirs/actions/runs/14202)
on Kvant failed in stock and patched upstream builds before Jest started.
Code generators were killed with exit 137. Kvant's kernel log identifies an
out-of-memory kill in the exact stock job container at 01:06:29 UTC on October
11. The pinned upstream root prebuild forces unlimited workspace parallelism.

The wrapper now runs the same tooling, workspace prebuild, TypeScript and UI
phases explicitly, with one workspace task at a time. A disposable workspace
check using pinned pnpm 11.11.0 verified phase order, absence of overlapping
workspace tasks and exclusion of the root's parallel lifecycle hooks. Bash
syntax and ShellCheck pass. These are wrapper checks; the repaired full hosted
build and test matrix remain unverified. The full Jest suite, source-tree
check and normalized package comparison remain required.

## Release gate and maintenance procedure

Live upstream tag discovery on October 6 still showed 0.5.37 as the latest PDS
package release. There is no natural next release on which to complete #22's
required rebase rehearsal. #5 is closed, with its prior distribution merge
record in [upstream-merge.md](../upstream-merge.md), but that does not provide
future release evidence for this patch set.

The final four patch commits replayed onto unreleased upstream main
`db3e7adc4bac5fc5e7f8632c8b9d64477d431a4b` without conflicts in 0.346 seconds.
The resulting local head `1ace84a7f08bee58bad515e8b8b6748dc2b64010` retains
that upstream commit as an ancestor. This is patch replay only. It excludes
fetch, build, tests and CI and does not satisfy the next-release gate.

When the next PDS release appears:

1. Fetch upstream and resolve the next package tag to its full commit. Record
   the tag, version, fetch time and commit. Reject unreleased main as a release.
2. Create a new isolated branch at that release. Replay only the four patch
   commits, timing the command and any manual conflict resolution. Retain all
   upstream commits and verify the release remains an ancestor. Never squash
   or rewrite upstream history.
3. Inspect the lifecycle, sequencer and Express seams described in
   upstream-merge.md. Record every conflict and its resolution. Add a regression
   test if the adapter seam moves or its behavior changes.
4. Build and run the full stock and patched upstream PDS suites. Pack and
   normalize the new archive. Update the fork commit/tree, patch, artifact
   SHA-256, package version, both consumer locks and CI release checkout as one
   reviewed change.
5. Run both Pirs smoke and installed-manifest/cursor qualifications and record
   total local qualification time separately from patch replay and hosted queue
   time. Open focused fork and integration PRs; link the exact commits and CI
   runs. Root owns merge and closure. Do not mark the gate complete until the
   natural release and full required checks have actually passed.

Levels 1 and 2 still have unimplemented requirements in the spec. These checks
verify existing stock-compatible seams, not general level 1/2 conformance.
#12's unchanged webhook demo still waits for #11. Owner gates 18, 28, 32, 35,
36 and Spaces 33 remain outside this change.
