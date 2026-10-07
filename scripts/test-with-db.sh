#!/usr/bin/env bash
# Run the backend test suite, live HTTP tests included, against a throwaway
# MariaDB 11 in Docker. Nothing is published on the host; the database
# container and network are removed afterwards. Names are unique per run, so
# several checkouts can use this at the same time.
#
#   scripts/test-with-db.sh                          # whole suite
#   scripts/test-with-db.sh test/live-boot.test.js   # selected files
set -euo pipefail
cd "$(dirname "$0")/../backend"

id="status-test-$$-$RANDOM"
pw=$(openssl rand -hex 16)
cleanup() {
  docker rm -f "$id-db" >/dev/null 2>&1 || true
  docker network rm "$id-net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$id-net" >/dev/null
docker run -d --name "$id-db" --network "$id-net" \
  -e MARIADB_ROOT_PASSWORD="$pw" \
  --health-cmd "healthcheck.sh --connect --innodb_initialized" \
  --health-interval 2s --health-retries 60 \
  mariadb:11 >/dev/null

for _ in $(seq 1 90); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$id-db")" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$id-db")" = healthy ] || { echo "MariaDB did not become healthy" >&2; exit 1; }

# Tests run from a copy so the checkout is never written to; the npm cache
# volume only speeds up repeated `npm ci`.
docker run --rm --network "$id-net" \
  -v "$PWD:/src:ro" -v status-server-npm-cache:/root/.npm \
  -e TEST_DB_HOST="$id-db" -e TEST_DB_PASSWORD="$pw" -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  node:26-alpine sh -c '
    cp -r /src /w && cd /w && rm -rf node_modules &&
    npm ci --no-audit --no-fund --loglevel=error &&
    node --test "$@"' sh "$@"
