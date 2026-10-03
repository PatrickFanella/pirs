# Upstream release merge and requalification

Issue: [#5](https://git.subcult.tv/subculture-collective/pirs/issues/5).

## Procedure

1. Confirm a clean worktree, the Pirs `origin`, and the Bluesky PDS `upstream`.
   Preserve any dirty work and choose a separate branch for the release.
2. Fetch both remotes. Identify the next upstream release after the last one
   carried by Pirs, and record its full commit and distribution tag.
3. Merge the upstream commit with `git merge --no-ff`. Keep its commits and
   ancestry; do not squash, rebase or rewrite upstream history. Time the merge
   command and record conflicts before resolving them.
4. Review the merge against its Pirs parent. Keep upstream changes and Pirs
   additions distinct. Preserve `UPSTREAM-README.md`; if an upstream release
   changes its README, review that source separately rather than overwriting
   Pirs's README or silently updating the preserved upstream copy.
5. Install from the frozen lockfile and inspect the resolved PDS source at the
   exact new package version. Check the three seams below before running tests.
6. From `service/`, run `pnpm smoke` and
   `node --test pirs/smoke.test.ts`. Retain exit statuses, event counts, cursor
   advancement, and successful/failing-path cleanup evidence.
7. Push the release branch and open a PR against current Pirs `main`. Require
   both push and PR smoke checks to pass on the final revision. Add run and
   merge links to this record and update spec section 8.

Commands for a clean, independently owned release branch:

```sh
git fetch origin
git fetch upstream
git switch -c qualify-upstream-release origin/main
git merge --no-ff --no-edit <full-upstream-release-commit>
cd service
pnpm install --frozen-lockfile
pnpm smoke
node --test pirs/smoke.test.ts
```

Use the configured agent Gitea identity for publishing and its Git author and
committer identity. Do not sign agent commits with an operator key.

## Seam checks when the PDS package changes

| Seam | Inspect | Required behavior |
| --- | --- | --- |
| `PDS.run` lifecycle | Callback names, callback order, awaiting `onStarted`, abort handling, disposal on failure | Routes attach before listening, sequencer listener attaches after startup, and the smoke can stop and dispose the PDS on success and failure |
| `ctx.sequencer` | Event emitter, event batch shape, `type` and `seq`, persistence and ordering | The bridge sees actual account/repository events; a subsequent record write advances both the commit count and cursor |
| Express app | The `pds.app` object, route installation order and the upstream catch-all handlers | Health and `/_pirs/status` answer through real HTTP requests, and Pirs's route does not enter the XRPC proxy |

If one seam changes, first establish the failing check. Keep any required
upstream wrapper change small and add evidence for the new behavior. Do not
mark an unrun replacement hook supported. A passing status route alone does
not prove event delivery.

New disposal behavior also warrants checking the cleanup tests. An upstream
blobstore, transport or database resource must not keep the smoke alive or
leave fixture state behind.

## October 3, 2026 rehearsal

Pirs parent: `5020e44de81e62200bdbd4ca3192fc41e5094513`.
Previous upstream release: `d02a23e5ba60b403728697bd50f7be15c69aeb66`,
distribution `v0.4.5036`, package `@atproto/pds` 0.5.36.
Next upstream release: `ed2dcb8616cd56ceab8e4f34973d2b2c67ea1bd9`,
distribution `v0.4.5037`, package 0.5.37.

The resulting [merge commit](https://git.subcult.tv/subculture-collective/pirs/commit/d57c53f0cf39f6e42e143a9943c757587939a19d)
has the Pirs parent and upstream release as its two parents. No upstream commit
was rewritten. `service/package.json` and `service/pnpm-lock.yaml` merged
automatically; there were no conflicts. The merge changed only those two files
and preserved the entrypoint, Pirs code, spec and `UPSTREAM-README.md`.

The merge started at 2026-10-03 21:56:23 UTC and the merge command took 0.012
seconds. Frozen installation, seam inspection, the smoke gate and both cleanup
checks finished at 21:57:37 UTC: 74.450 seconds from merge start. That elapsed
time includes inspection and orchestration; it excludes fetch, documentation,
hosted queue time and CI. It is an observation for this small release, not a
forecast for future merges.

The resolved 0.5.36 and 0.5.37 `dist/index.js` and
`dist/sequencer/sequencer.js` files were byte-identical. The `context.js`
changes add an optional blobstore override and blobstore disposal after
transport disposal; neither changes how Pirs attaches its listener or routes.
The cleanup tests passed against the new disposal path.

Local qualification on Kvant, Node 26.10.0 and pnpm 10.34.1:

```text
pnpm install --frozen-lockfile: passed
pnpm smoke: passed
counts: { commit: 2, sync: 1, identity: 1, account: 1 }
afterAccount: 4
afterWrite: 5
cleanup tests: 2 passed, 0 failed
```

After the container PR merged to `main`, this branch also merged that updated
main in commit `1ef30c7d977d9f389a95fb624c143e5382c5a8b7`. Both branches had
appended evidence to spec section 8, producing one documentation conflict.
The resolution retains the container record followed by the upstream rehearsal
record. It does not alter package code or rewrite either merge's ancestry.

The post-resolution `pnpm smoke` passed. The container qualification script
then built the original Dockerfile from committed revision `1ef30c7` and
booted version `0.4.5037`. Health and bridge status answered, the listener was
attached, the only published host IP was `127.0.0.1`, and `/data` was the only
mount. The local image ID/index is
`sha256:9654aad01ae76d4de73534cccd4a8db0aff30ad552581617c46fa6e274a1f849`;
its linux/amd64 manifest is
`sha256:b391d1c8dcf5981bba00eb767ab2f1c18da3c0c2f0e2e2d1908711a8831d3239`.
The base remained the Node digest recorded in the
[container qualification](qualification/container.md). Teardown left only
`pirs-proof-68cb1b3f16d3_data`, which was removed by exact name afterward.

The first container build at this revision failed in the production install
step. The upstream Dockerfile suppresses that command's output, so the cause
was not established. A diagnostic copy with the suppression removed passed;
one retry of the original, unchanged Dockerfile then passed the full boot and
teardown check. This is a recovered build failure, not proof of its cause.

Hosted qualification links are added after the release PR finishes its checks.
This local image check does not prove a deployed service, arm64 build or
registry artifact. No deployment or image publication is part of the rehearsal.

## Recovery

Before merge, closing the release PR leaves `main` unchanged. After merge,
use a separate revert PR and rerun qualification; a Git merge revert requires
the Pirs parent as mainline (`git revert -m 1 <merge-commit>`). Do not reset a
shared branch or prune the upstream commits. No production rollback is needed
for this rehearsal because it deploys nothing.
