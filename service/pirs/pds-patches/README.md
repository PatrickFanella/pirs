# Pinned PDS patch package

`pins.json` identifies the upstream release, the private fork commit and tree,
the exported patch, and the canonical package archive by SHA-256. Pirs installs
the archive through a file dependency; it does not download a moving branch.
The fork PR is [pirs-atproto #1](https://git.subcult.tv/subculture-collective/pirs-atproto/pulls/1).

There is one hook, `PdsHooks.xrpcMiddleware`. These are trusted transport
adapters, not plugin code. They run under `/xrpc` after CORS, basic routes and
well-known routes, before the XRPC router and its existing error handler.
The optional argument is passed through `PDS.create`, `PDS.fromEnv` and
`PDS.run`. An omitted or empty list leaves upstream routing unchanged.
Pirs does not install an adapter by default. This does not implement
`record.validate`, `record.unique`, `account.create` or `auth.session`.

## Reproduce and select

From the Pirs root, give `build.sh` a clean disposable checkout at the pinned
upstream commit. The patched track applies `hooks.patch` and requires its Git
tree to equal the pinned fork tree. This allows CI to reproduce the private
fork's source from public upstream without a provider credential.

```sh
bash service/pirs/pds-patches/build.sh patched /tmp/atproto
cmp service/pirs/pds-patches/build/patched/atproto-pds-0.5.37.tgz service/pirs/pds-patches/atproto-pds-0.5.37-pirs-7357a80.tgz
node service/pirs/pds-patches/select.mjs patched
pnpm --dir service install --frozen-lockfile
pnpm --dir service smoke
```

The caller supplies disposable Postgres and Redis via `DB_POSTGRES_URL` and
`REDIS_HOST`. The script installs the exact upstream lock, builds upstream,
installs the test browser and runs every upstream PDS test. One worker and
worker recycling limit retained Jest memory; a heap exhaustion still fails
the gate. Browser dependency installation requires a disposable Debian runner.

`pnpm pack` resolves workspace dependency keys in varying order. `normalize.mjs`
sorts package metadata keys and archive entries and fixes archive ownership
and timestamps. It preserves every built file byte. Two independent packs
were identical after normalization. CI requires a byte match with the vendored
package after rebuilding it. A hash in the Pirs lock also pins the archive.

`select.mjs stock` selects published `@atproto/pds` 0.5.37 and the stock frozen
lock. `select.mjs patched` restores the file dependency and patched frozen lock.
Both selections check the vendored archive's hash. Do not commit a stock
selection over the intended patched integration.

The CI matrix runs upstream PDS tests, Pirs smoke, cleanup and bridge tests,
type checking, and installed-manifest consumer/restart qualification on both
tracks. Its stock upstream suite uses source from the release tag; stock Pirs
smoke installs the published package. These are distinct checks.

For acceptance evidence and the unresolved release gate, see
[the qualification record](../../../docs/qualification/pds-patches.md).
