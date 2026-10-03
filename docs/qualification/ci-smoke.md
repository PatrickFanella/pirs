# Gitea smoke qualification

Issue: [#2](https://git.subcult.tv/subculture-collective/pirs/issues/2).
PR: [#39](https://git.subcult.tv/subculture-collective/pirs/pulls/39).
Observed on Kvant and git.subcult.tv on 2026-10-03.

## Workflow and repository settings

`.gitea/workflows/smoke.yaml` runs on every push and pull request, with no
branch or path filters. It uses `node:24-bookworm`, enables Corepack, installs
the service dependencies with `pnpm install --frozen-lockfile`, and runs
`pnpm smoke`. Corepack selected the package's pinned pnpm 10.34.1 in the hosted
logs. Checkout uses `persist-credentials: false`. The job has a ten-minute
timeout and no registry login, image publishing, or deployment step.

The server version endpoint returned Gitea 1.27.3. In that version,
[the default workflow directory order](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/setting/actions.go)
is `.gitea/workflows`, then `.github/workflows`, and
[workflow discovery](https://github.com/go-gitea/gitea/blob/v1.27.3/modules/actions/workflows.go)
stops at the first existing directory.

Commit `f3d607d01fb0d7d376f9762af1e1d5efbfbd0398` temporarily changed
`Dockerfile`, which matches the upstream publishing workflow's PR path filter.
The server created only `smoke.yaml` runs for that commit:
[push 12144](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12144)
and [PR 12145](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12145).
It created no `build-and-push-ghcr.yaml` run. Both deliberate probes were
reverted; the final diff leaves the upstream workflow and Dockerfile unchanged.

Repository Actions are enabled. The upstream publishing workflow was also
disabled through Gitea's workflow API; readback returned `disabled_manually`.
This guards the default branch while this PR is unmerged and it still lacks
the `.gitea/workflows` directory. Keep that workflow disabled. Repository and
organization Actions secret endpoints both returned empty lists. No secret
was added. Gitea's automatic checkout token is separate from configured secrets.

## Failure and recovery

| Revision | Event | Run | Result |
| --- | --- | --- | --- |
| `1bfe91b44af8cf0bc8fe416d51226b275f17f129` | PR | [12139](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12139) | Passed: health, status, one identity event |
| `9d02e38ea76f43ef50db1cd03649c2fca741f0d9` | push | [12142](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12142) | Failed: listener stopped updating counters |
| same | PR | [12143](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12143) | Failed with the same listener probe |
| `12417f425a2d9bfaaccc6b68f8951546b52029d3` | push | [12146](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12146) | Passed after both probes were reverted |
| same | PR | [12147](https://git.subcult.tv/subculture-collective/pirs/actions/runs/12147) | Passed after both probes were reverted |

The failing push log reports `smoke failed: Error: sequencer event was not
delivered within 10s`, then exit code 1 and `Job failed`. Dependency installation
completed first. This proves the smoke assertion fails the hosted job.

Local frozen-lockfile installation and `pnpm smoke` passed before the probe and
after both reverts. The local runtime was Node 26.10.0 with pnpm 10.34.1. These
runs used the smoke script's disposable data and generated secrets, with the
PLC URL set to loopback. Hosted jobs used Node 24 on the Kvant runner.

## Scope and recovery

This qualifies workflow selection and propagation of the current smoke check's
exit status. It does not qualify real account events, a plugin host, container
distribution, production service, or any additional hook.

To stop Pirs jobs, disable repository Actions with the repository API. Do not
remove `.gitea/workflows` while Actions remain enabled or enable the upstream
publishing workflow. No image or deployment was produced by this work.
