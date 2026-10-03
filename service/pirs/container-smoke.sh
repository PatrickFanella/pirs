#!/usr/bin/env bash
# Build a committed Pirs snapshot, boot its normal entrypoint, and prove local
# routes and teardown. Retain only this run's named data volume for inspection.
set -Eeuo pipefail
umask 077

root=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
revision=$(git -C "$root" rev-parse HEAD)
state=$(mktemp -d "${TMPDIR:-/tmp}/pirs-container-XXXXXX")
project="pirs-proof-$(openssl rand -hex 6)"
export PIRS_IMAGE="pirs:proof-${revision:0:12}"
export PIRS_ENV_FILE="$state/pds.env"
export PIRS_CONTAINER_PORT="${PIRS_CONTAINER_PORT:-2598}"
compose=(docker compose -p "$project" -f "$root/service/pirs/compose.local.yaml")
started=false

cleanup() {
  local code=$?
  trap - EXIT
  if [[ "$started" == true ]]; then
    if ! "${compose[@]}" down --timeout 15; then
      printf 'Teardown failed for project %s; secret file retained at %s\n' "$project" "$PIRS_ENV_FILE" >&2
      exit 1
    fi
  fi
  rm -rf -- "$state"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$state/source"
# Include only the committed source, never local dependencies or environment files.
git -C "$root" archive HEAD | tar -x -C "$state/source"
docker build --pull --progress=plain --tag "$PIRS_IMAGE" "$state/source"
image_id=$(docker image inspect --format '{{.Id}}' "$PIRS_IMAGE")
printf 'source=%s\nimage=%s\nimage_id=%s\n' "$revision" "$PIRS_IMAGE" "$image_id"
docker run --rm --network none --entrypoint node "$PIRS_IMAGE" --input-type=module -e '
  import { existsSync } from "node:fs";
  import { SPEC_DRAFT } from "./pirs/bridge.ts";
  if (SPEC_DRAFT !== "0" || !existsSync("./index.ts")) process.exit(1);
  console.log("ok: bridge included, spec draft", SPEC_DRAFT);
'

cat > "$PIRS_ENV_FILE" <<EOF
PDS_HOSTNAME=localhost
PDS_DATA_DIRECTORY=/data
PDS_BLOBSTORE_DISK_LOCATION=/data/blocks
PDS_JWT_SECRET=$(openssl rand -hex 32)
PDS_ADMIN_PASSWORD=$(openssl rand -hex 16)
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=$(openssl rand -hex 32)
PDS_DID_PLC_URL=http://127.0.0.1:1
PDS_CRAWLERS=
LOG_ENABLED=false
EOF

started=true
"${compose[@]}" up --detach --no-build --pull never
container=$("${compose[@]}" ps --quiet pds)
[[ -n "$container" ]]
docker inspect --format '{{json .NetworkSettings.Ports}}' "$container" |
  python3 -c 'import json,sys; p=json.load(sys.stdin); b=p["3000/tcp"]; assert len(b)==1 and b[0]["HostIp"]=="127.0.0.1",p; print("ok: port published on loopback only")'
docker inspect --format '{{json .Mounts}}' "$container" |
  python3 -c 'import json,sys; m=json.load(sys.stdin); assert len(m)==1 and m[0]["Type"]=="volume" and m[0]["Destination"]=="/data",m; print("ok: only data volume mounted")'

base="http://127.0.0.1:$PIRS_CONTAINER_PORT"
ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl --silent --fail --max-time 2 "$base/xrpc/_health" > "$state/health.json"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  printf 'PDS did not become healthy within the readiness window\n' >&2
  exit 1
fi
curl --silent --show-error --fail --max-time 5 "$base/_pirs/status" > "$state/status.json"
python3 - "$state/health.json" "$state/status.json" <<'PY'
import json, sys
health = json.load(open(sys.argv[1]))
status = json.load(open(sys.argv[2]))
assert health.get('version'), health
assert status['specDraft'] == '0' and status['events']['listening'] is True, status
assert set(status['events']['counts']) == {'commit', 'sync', 'identity', 'account'}, status
print('ok: health and bridge status', json.dumps({'health': health, 'status': status}))
PY

"${compose[@]}" down --timeout 15
started=false
[[ -z $(docker ps --all --quiet --filter "label=com.docker.compose.project=$project") ]]
[[ -z $(docker network ls --quiet --filter "label=com.docker.compose.project=$project") ]]
volume="${project}_data"
[[ $(docker volume ls --quiet --filter "label=com.docker.compose.project=$project") == "$volume" ]]
printf 'ok: no project containers or networks remain; data volume=%s\n' "$volume"
printf 'Remove only this retained fixture volume with: docker volume rm %s\n' "$volume"
