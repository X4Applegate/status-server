#!/usr/bin/env bash
# promote-replica.sh — turn this Replica into the new Primary.
#
# Usage: sudo ./promote-replica.sh
#
# What it does:
#   1. Verifies this is actually a Replica (SHOW SLAVE STATUS returns a row)
#   2. Confirms with you — promotion is one-way without re-bootstrap
#   3. STOP SLAVE; RESET SLAVE ALL; SET GLOBAL read_only = 0
#   4. Starts the status-server container
#   5. Prints the next steps (point Cloudflare, re-bootstrap old Primary as new Replica)
#
# Safe to re-run — if already promoted, step 3 is a no-op.

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/status-server}"
DB_CONTAINER="${DB_CONTAINER:-mariadb}"
APP_CONTAINER="${APP_CONTAINER:-status-server}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "ERROR: MariaDB container '$DB_CONTAINER' is not running." >&2
  echo "Start it first:  cd $COMPOSE_DIR && docker compose up -d mariadb" >&2
  exit 1
fi

echo "=== Pre-flight check ==="
echo "Current replication state:"
docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-}" \
  -e "SHOW SLAVE STATUS\G" 2>/dev/null \
  | grep -E "Slave_IO_Running|Slave_SQL_Running|Seconds_Behind_Master|Last_.*_Error|Read_Only" \
  || {
    echo "(no SHOW SLAVE STATUS output — this node may already be promoted.)"
  }

echo
read -rp "Promote this Replica to Primary? Type 'promote' to confirm: " ans
if [ "$ans" != "promote" ]; then
  echo "Aborted."
  exit 1
fi

echo
echo "=== Promoting ==="
docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-}" <<SQL
STOP SLAVE;
RESET SLAVE ALL;
SET GLOBAL read_only = 0;
SQL

echo "✓ MariaDB is now writable and no longer replicating."
echo

echo "=== Starting status-server container ==="
cd "$COMPOSE_DIR"
docker compose up -d "$APP_CONTAINER"
echo "✓ status-server started"

echo
echo "=== Sanity check ==="
sleep 3
if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
  echo "✓ /health returns 200 — app is serving"
else
  echo "! /health did not return 200 — check: docker logs $APP_CONTAINER"
fi

echo
cat <<'NEXT'
=== Next steps ===

1. Confirm Cloudflare Load Balancing has already failed over to this node
   (check the LB analytics). The /health probe should be green.

2. When the old Primary comes back online:
     - DO NOT just start its status-server container.
     - Its DB is now diverged. Re-bootstrap it as the new Replica
       following docs/HIGH_AVAILABILITY.md Part 2, but with the
       roles reversed.

3. Most people then leave the swap in place. Active/passive doesn't
   care which box is which — this is now your new Primary.
NEXT
