# Pirs

Pirs is an experiment in making an AT Protocol PDS extensible. It has two parts: a draft specification of the hook points a PDS offers to plugins, and a PDS distribution that implements them.

It is not production software and no plugin runs yet. Prichal's managed hosting stays on the unmodified upstream image; Pirs becomes an option there only if it qualifies.

## What is here

- [docs/spec/hook-points.md](docs/spec/hook-points.md): draft 0 of the hook-point spec, with levels, hooks, a capability vocabulary and open questions.
- `service/pirs/bridge.ts`: the code that attaches to the PDS. Today it adds `GET /_pirs/status` and counts events from the PDS's sequencer.
- `service/pirs/smoke.ts`: boots a throwaway PDS with the bridge and checks that a sequenced event reaches it.

Everything else is the upstream Bluesky PDS distribution, kept so that upstream changes can be merged. Its original README is [UPSTREAM-README.md](UPSTREAM-README.md).

## Design in brief

Plugins run in a separate host process, not inside the PDS, and never receive signing keys. The PDS and the host talk through mechanisms atproto already has (the event stream, service proxying) wherever those are enough, so that other PDS implementations can adopt the same contract. Hooks that reject or rewrite a request need a change to the PDS and are specified separately as level 3.

The host does not exist yet. The planned runtime is wasmtime in its own process.

## Run the check

Requires Node 22 or later and pnpm.

```sh
cd service
pnpm install --frozen-lockfile
pnpm smoke
```

The smoke check uses a temporary data directory and generated secrets. It contacts no PLC directory and creates no account. It listens on `127.0.0.1:2597`; set `PIRS_SMOKE_PORT` to change the port.

## Tracking upstream

The `upstream` remote is `https://github.com/bluesky-social/pds.git`. Pirs code lives in `service/pirs/` and `docs/`, with small changes to `service/index.ts` and `service/package.json`, to keep merges small.

```sh
git fetch upstream
git merge upstream/main
cd service && pnpm install --frozen-lockfile && pnpm smoke
```

## Licence

Upstream code is dual-licensed MIT and Apache-2.0; see [LICENSE.txt](LICENSE.txt). Pirs additions are offered under the same terms.
