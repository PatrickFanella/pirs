#!/usr/bin/env bash
set -euo pipefail
# Run from the Pirs root. A disposable upstream checkout is required.
track=${1:?stock or patched}
checkout=${2:?path to a disposable atproto checkout}
root=$(pwd)
case "$track" in stock|patched) ;; *) exit 2 ;; esac
pins="$root/service/pirs/pds-patches/pins.json"
base=$(node -p "require('$pins').upstreamCommit")
expected_tree=$(node -p "require('$pins').forkTree")
if [[ "$(git -C "$checkout" rev-parse HEAD)" != "$base" ]]; then
  echo 'checkout is not the pinned upstream release' >&2; exit 1
fi
if [[ -n "$(git -C "$checkout" status --porcelain)" ]]; then
  echo 'checkout must be clean' >&2; exit 1
fi
if [[ "$track" == patched ]]; then
  git -C "$checkout" apply --index "$root/service/pirs/pds-patches/hooks.patch"
  if [[ "$(git -C "$checkout" write-tree)" != "$expected_tree" ]]; then
    echo 'patched source differs from the pinned fork tree' >&2; exit 1
  fi
fi
cd "$checkout"
PUPPETEER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile
# The pinned root build's pre/post hooks force unlimited workspace parallelism.
# Run those same phases explicitly so bounded CI containers do not OOM during
# code generation. Recursive runs exclude the root and retain dependency order.
pnpm --config.enable-pre-post-scripts=false run build:tooling --force
pnpm --recursive --workspace-concurrency=1 run prebuild
pnpm --config.enable-pre-post-scripts=false run build:ts
pnpm --recursive --workspace-concurrency=1 run build:ui
# Full upstream suite, including proxied tests and browser tests. The caller
# supplies disposable Redis/Postgres via REDIS_HOST and DB_POSTGRES_URL.
(cd packages/pds && pnpm exec puppeteer browsers install chrome --install-deps)
(cd packages/pds && LOG_ENABLED=false NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=8192" pnpm exec jest --maxWorkers=1 --workerIdleMemoryLimit=512MB)
mkdir -p "$root/service/pirs/pds-patches/build/$track"
(cd packages/pds && pnpm pack --pack-destination "$root/service/pirs/pds-patches/build/$track")
node "$root/service/pirs/pds-patches/normalize.mjs" "$root/service/pirs/pds-patches/build/$track/atproto-pds-0.5.37.tgz"
