# Local container qualification

Issue: [#4](https://git.subcult.tv/subculture-collective/pirs/issues/4).
Observed on Kvant on 2026-10-03, linux/amd64, Docker 29.7.2, Compose 5.5.1.

## Reproduce

Commit the intended source, then run from the repository root:

```sh
bash service/pirs/container-smoke.sh
```

The script builds `git archive HEAD` with the existing root Dockerfile. It
excludes local dependencies and untracked environment files by construction.
It starts the normal `dumb-init -- node --enable-source-maps index.ts`
entrypoint using `service/pirs/compose.local.yaml`. The Dockerfile and service
entrypoint are unchanged.

The Compose recipe requires a local image and an environment file. The script
generates secrets in a mode-0600 temporary file, uses a fresh named data volume,
and publishes only `127.0.0.1:2598:3000`. Set `PIRS_CONTAINER_PORT` to select
another loopback port. The service hostname is `pirs-container.invalid`, which
provides the HTTPS resource identity required by the production OAuth routes.
It is not a public hostname. The PLC URL is the container's loopback discard
port; no account is created. Crawlers are disabled.

## Image evidence

Qualified source: `8caf22b7e8af700554cf5f71ed4c9a231347d504`.

| Artifact | Observed reference |
| --- | --- |
| Both Dockerfile base stages | `node:24.19-alpine3.23` |
| Resolved base index | `sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995` |
| Base linux/amd64 manifest | `sha256:5098ee834c9345ddd7fc2828a01dc90aa6de0e9ed6804a09a959b19a1fded97a` |
| Local result tag | `pirs:proof-8caf22b7e8af` |
| Local result image ID/index | `sha256:482f3949351c1e8ec5380238a983e067d642967d6a950fcc79e35b46ef59c4ec` |
| Result linux/amd64 manifest | `sha256:c18be9323d6a7999f8d52ab2cb2b32e8a9b69a6063628aab1b1bd4ed66afaf95` |

The existing Dockerfile pins the Node version tag and goat v0.2.2, not an
immutable base digest. The table records what this run resolved; it does not
claim byte-for-byte reproducible builds. No registry push was performed.

## Boot and teardown evidence

The script imported `pirs/bridge.ts` inside the built image and confirmed spec
draft 0. The running container returned:

```json
{"version":"0.4.5036"}
```

from `/xrpc/_health`, and `/_pirs/status` reported the same PDS version, spec
draft 0, `listening: true`, a null cursor, and zero event counts. This proves
bridge attachment in the distribution entrypoint, not account-event delivery
inside the container.

Runtime inspection confirmed one published binding, with host IP
`127.0.0.1`, and one mount: the named volume at `/data`. There was no Docker
socket mount. The recipe limits memory to 512 MiB, CPU to one core and PIDs to
128; no shared host limit was changed.

After `compose down`, label-based checks found no project containers or
networks and exactly `pirs-proof-2a0f94bba917_data`. The temporary source and
secret directory was removed by the script. The data volume was subsequently
removed by its exact name after verification; local images and build cache
remain available for review. No other project's resources were removed.

An initial probe with `PDS_HOSTNAME=localhost` exited because the production
OAuth routes require an HTTPS resource URL. Changing the fixture hostname
resolved that failure. ShellCheck, the repository's `pnpm smoke` gate, and both
account-smoke cleanup tests passed locally.

## Proof boundary

This is local linux/amd64 build, boot, route, mount and teardown qualification.
It does not qualify arm64, a public TLS ingress, a registry artifact, a plugin
host or a production deployment. Gitea smoke-check evidence for the final PR
revision is recorded in the PR separately.
