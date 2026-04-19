#!/usr/bin/env bash
# promote-replica.sh — turn this Replica into the new Primary.
#
# Usage: sudo ./promote-replica.sh
#
# What it does:
#   1. Verifies this is actually a Replica (SHOW SLAVE STATUS returns a row)
#   2. Confirms with you — promotion is one-way without re-bootstrap
#   3. STOP SLAVE; RESET SLAVE ALL; SET GLOBAL read_only = 0
#   4. Verifies RESET SLAVE ALL actually cleared all state (some versions don't)
#   5. Comments out --read-only=1 in the compose file so a restart doesn't
#      silently revert the DB back to read-only (runtime SET GLOBAL alone
#      does NOT survive a container restart if the flag is still in command:)
#   6. Starts the status-server container (detects Portainer-managed compose
#      and skips gracefully — you start it via Portainer in that case)
#   7. Starts the cloudflared systemd service so the Cloudflare Tunnel
#      connector on this box registers with the edge (traffic routes here
#      once the connector shows HEALTHY — usually ~10-20 seconds)
#   8. Prints the next steps (re-bootstrap old Primary as new Replica)
#
# Safe to re-run — if already promoted, steps 3-7 are no-ops.
#
# Configuration (env vars):
#   COMPOSE_DIR        — directory containing docker-compose.yml  [/opt/status-server]
#   DB_COMPOSE_DIR     — directory containing mariadb compose file if different
#                        from COMPOSE_DIR. Leave unset to auto-detect from the
#                        mariadb container labels.
#   DB_CONTAINER       — MariaDB container name                    [mariadb]
#   APP_CONTAINER      — status-server container name              [status-server]
#   CLOUDFLARED_SVC    — systemd service unit name                 [cloudflared]
#                        Set to empty string to skip the tunnel step
#                        (e.g. if you're using a Cloudflare Load Balancer
#                        with direct-to-IP origins instead of tunnels).

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/status-server}"
DB_COMPOSE_DIR="${DB_COMPOSE_DIR:-}"
DB_CONTAINER="${DB_CONTAINER:-mariadb}"
APP_CONTAINER="${APP_CONTAINER:-status-server}"
CLOUDFLARED_SVC="${CLOUDFLARED_SVC:-cloudflared}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "ERROR: MariaDB container '$DB_CONTAINER' is not running." >&2
  echo "Start it first:  cd $COMPOSE_DIR && docker compose up -d mariadb" >&2
  exit 1
fi

# Auto-detect the compose file that owns the mariadb container. This matters
# because in real deployments the DB is often in a separate compose project
# from status-server (e.g. shared with nextcloud, cloudron, another app),
# and --read-only=1 lives in the DB's compose file, not status-server's.
DB_COMPOSE_FILE=""
if [ -z "$DB_COMPOSE_DIR" ]; then
  DB_COMPOSE_FILE="$(docker inspect "$DB_CONTAINER" \
    --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true)"
  # Take first path if multiple are returned
  DB_COMPOSE_FILE="${DB_COMPOSE_FILE%%,*}"
else
  DB_COMPOSE_FILE="$DB_COMPOSE_DIR/docker-compose.yml"
fi

echo "=== Pre-flight check ==="
echo "Current replication state:"
docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-}" \
  -e "SHOW SLAVE STATUS\G" 2>/dev/null \
  | grep -E "Slave_IO_Running|Slave_SQL_Running|Seconds_Behind_Master|Last_.*_Error|Read_Only" \
  || {
    echo "(no SHOW SLAVE STATUS output — this node may already be promoted.)"
  }

if [ -n "$DB_COMPOSE_FILE" ] && [ -f "$DB_COMPOSE_FILE" ]; then
  echo
  echo "MariaDB compose file:  $DB_COMPOSE_FILE"
else
  echo
  echo "! Could not auto-detect mariadb compose file via container labels."
  echo "  You'll need to manually comment out --read-only=1 post-promotion."
  echo "  Set DB_COMPOSE_DIR to the directory containing it, or edit by hand."
fi

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

# Verify RESET SLAVE ALL actually cleared everything. On some MariaDB versions
# a stale entry in mysql.slave_relay_log_info or relay_log_info_file can leave
# Master_Host set, which will cause replication to auto-restart on DB restart
# and generate "1236 Could not find first log file" errors.
if docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-}" \
     -e "SHOW SLAVE STATUS\G" 2>/dev/null | grep -qE "^\s*Master_Host:\s*\S"; then
  echo "! WARNING: SHOW SLAVE STATUS still shows a Master_Host after RESET SLAVE ALL."
  echo "  Re-running cleanup and removing multi-master.info if present..."
  docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-}" \
    -e "STOP ALL SLAVES; RESET SLAVE ALL;" 2>/dev/null || true
  docker exec "$DB_CONTAINER" sh -c \
    'rm -f /var/lib/mysql/multi-master.info /var/lib/mysql/relay-log.info' 2>/dev/null || true
  echo "  Consider restarting the mariadb container after this script finishes."
fi

echo "✓ MariaDB is now writable and no longer replicating."
echo

# Comment out --read-only=1 in the DB's compose file so future restarts keep
# the DB writable. Runtime SET GLOBAL read_only=0 (above) alone does NOT
# survive a container restart if --read-only=1 is still in command:.
if [ -n "$DB_COMPOSE_FILE" ] && [ -f "$DB_COMPOSE_FILE" ]; then
  if grep -qE '^[[:space:]]*-[[:space:]]+--read-only=1' "$DB_COMPOSE_FILE"; then
    echo "=== Disabling --read-only=1 in compose ==="
    # Backup once
    cp -n "$DB_COMPOSE_FILE" "${DB_COMPOSE_FILE}.pre-promote.bak"
    sed -i -E 's|^([[:space:]]*)-([[:space:]]+)--read-only=1|\1#-\2--read-only=1  # commented by promote-replica.sh|' \
      "$DB_COMPOSE_FILE"
    echo "✓ Commented --read-only=1 in $DB_COMPOSE_FILE"
    echo "  (backup at ${DB_COMPOSE_FILE}.pre-promote.bak)"
  else
    echo "(--read-only=1 already absent from $DB_COMPOSE_FILE — nothing to do.)"
  fi
fi

echo
echo "=== Starting status-server container ==="
cd "$COMPOSE_DIR"
# Detect whether this compose directory actually has a compose file. In
# Portainer-managed stacks the compose file lives under /data/compose/<id>/
# and `docker compose` invoked from $COMPOSE_DIR can't find it. In that case
# we skip the CLI start — the user starts it via Portainer.
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ] && [ ! -f "$COMPOSE_DIR/compose.yml" ]; then
  APP_COMPOSE_FILE="$(docker inspect "$APP_CONTAINER" \
    --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true)"
  if [ -n "$APP_COMPOSE_FILE" ]; then
    echo "! $APP_CONTAINER is managed by a compose stack at: $APP_COMPOSE_FILE"
    echo "  (This looks like Portainer or another external manager.)"
    echo "  Start the container via that tool — this script can't do it from here."
  else
    echo "! No compose file in $COMPOSE_DIR and no compose labels on $APP_CONTAINER."
    echo "  Start $APP_CONTAINER manually (e.g. Portainer, systemd, docker run)."
  fi
else
  # If docker-compose gates status-server behind the `promoted` profile, this
  # picks it up (honors `profiles: [promoted]`).
  docker compose --profile promoted up -d "$APP_CONTAINER" 2>/dev/null \
    || docker compose up -d "$APP_CONTAINER"
  echo "✓ status-server started"
fi

# Determine the port the app listens on from the container. Default 3000, but
# many HA setups use 3200 on loopback (Cloudron host, etc.) — see
# docs/HIGH_AVAILABILITY.md "Known gotchas".
APP_PORT="$(docker port "$APP_CONTAINER" 3000/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}')"
APP_PORT="${APP_PORT:-3000}"

echo
echo "=== Sanity check (local) ==="
sleep 3
if curl -fsS "http://localhost:${APP_PORT}/health" >/dev/null 2>&1; then
  echo "✓ /health returns 200 on localhost:${APP_PORT} — app is serving"
else
  echo "! /health did not return 200 on localhost:${APP_PORT} — check: docker logs $APP_CONTAINER"
fi

# Start cloudflared so this box's tunnel connector registers with Cloudflare.
# Traffic will route here automatically once the connector goes HEALTHY at
# the edge (typically 10-20 seconds after start).
if [ -n "$CLOUDFLARED_SVC" ]; then
  echo
  echo "=== Starting cloudflared systemd service ==="
  # `systemctl cat` is the most reliable existence check — works for native,
  # drop-in, and override units. `list-unit-files | grep` misses some layouts.
  if systemctl cat "$CLOUDFLARED_SVC" >/dev/null 2>&1; then
    systemctl start "$CLOUDFLARED_SVC"
    # Enable so it also survives a reboot during the failover period
    systemctl enable "$CLOUDFLARED_SVC" 2>/dev/null || true
    sleep 5
    if systemctl is-active --quiet "$CLOUDFLARED_SVC"; then
      echo "✓ $CLOUDFLARED_SVC is running — tunnel connector should register within ~20s"
    else
      echo "! $CLOUDFLARED_SVC failed to start — check:  journalctl -u $CLOUDFLARED_SVC -n 50"
    fi
  else
    echo "! $CLOUDFLARED_SVC service unit not found on this host — skipping."
    echo "  (If you're using Cloudflare Tunnel, install the connector first; see"
    echo "   docs/HIGH_AVAILABILITY.md. If you're using a Load Balancer instead,"
    echo "   set CLOUDFLARED_SVC='' to silence this warning.)"
  fi
fi

echo
cat <<'NEXT'
=== Next steps ===

1. Verify the new Primary is serving public traffic:
     curl -s https://gateway.richardapplegate.io/health | jq .
   (Replace with your own hostname if different. Should return
    "ok":true and the version.)

2. In the Cloudflare dashboard → Zero Trust → Networks → Tunnels,
   confirm BOTH connectors are now HEALTHY (the old Primary may still be
   Connected if it's up and cloudflared is running; that's fine — when
   you stop cloudflared on the old Primary during re-bootstrap, it
   drops out of rotation automatically).

3. When the old Primary comes back online:
     - DO NOT just start its status-server container.
     - Its DB is now diverged. Re-bootstrap it as the new Replica
       following docs/HIGH_AVAILABILITY.md Part 2, but with the
       roles reversed.
     - On the old Primary, also:
         systemctl stop cloudflared
         systemctl disable cloudflared
       so its tunnel connector doesn't register and accidentally
       absorb traffic while the DB is still being re-bootstrapped.
     - During the re-bootstrap catch-up, if the replica hits
       "Duplicate entry for key 'PRIMARY'" errors (error 1062),
       that's the normal --flush-logs + live-writes race. Fix:
           STOP SLAVE;
           SET GLOBAL slave_exec_mode='IDEMPOTENT';
           START SLAVE;
           -- wait for Seconds_Behind_Master=0 and primary MAX(id) to
           -- clearly exceed the last dup id, then:
           STOP SLAVE;
           SET GLOBAL slave_exec_mode='STRICT';
           START SLAVE;

4. Most people leave the swap in place. Active/passive doesn't
   care which box is which — this is now your new Primary.
NEXT
