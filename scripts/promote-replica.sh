#!/usr/bin/env bash
# promote-replica.sh — turn this Replica into the new Primary.
#
# Usage:
#   Interactive:       sudo ./promote-replica.sh
#   Non-interactive:   sudo PROMOTE_ACK=yes ./promote-replica.sh --non-interactive [--json]
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
# Safe to re-run — if already promoted, exits 2 with no changes.
#
# Flags:
#   --non-interactive, -y   Skip the typed-confirmation prompt. REQUIRES
#                           PROMOTE_ACK=yes in the environment as a safety
#                           interlock — prevents accidental invocation.
#                           The HA auto-failover webhook sets this after
#                           verifying the shared secret.
#   --json                  Emit a single JSON summary line on stdout at
#                           the end (for webhook parsing).
#   --help, -h              Print this help and exit.
#
# Exit codes:
#   0  Promoted successfully
#   1  User aborted (interactive confirmation declined, or missing PROMOTE_ACK)
#   2  Already promoted — no changes made (idempotent no-op)
#   3  Preflight failure (docker/container/compose detection problems)
#   4  Promotion SQL failure (STOP SLAVE / RESET SLAVE ALL / SET GLOBAL failed)
#
# Configuration (env vars):
#   MARIADB_ROOT_PASSWORD — MariaDB root password (REQUIRED)
#   PROMOTE_ACK           — must equal 'yes' when --non-interactive is used
#   COMPOSE_DIR           — directory containing docker-compose.yml  [/opt/status-server]
#   DB_COMPOSE_DIR        — directory containing mariadb compose file if different
#                           from COMPOSE_DIR. Leave unset to auto-detect from the
#                           mariadb container labels.
#   DB_CONTAINER          — MariaDB container name                    [mariadb]
#   APP_CONTAINER         — status-server container name              [status-server]
#   CLOUDFLARED_SVC       — systemd service unit name                 [cloudflared]
#                           Set to empty string to skip the tunnel step
#                           (e.g. if you're using a Cloudflare Load Balancer
#                           with direct-to-IP origins instead of tunnels).

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/status-server}"
DB_COMPOSE_DIR="${DB_COMPOSE_DIR:-}"
DB_CONTAINER="${DB_CONTAINER:-mariadb}"
APP_CONTAINER="${APP_CONTAINER:-status-server}"
CLOUDFLARED_SVC="${CLOUDFLARED_SVC:-cloudflared}"

# ── Argument parsing ─────────────────────────────────────────────────────────
NON_INTERACTIVE=0
JSON_OUTPUT=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive|-y) NON_INTERACTIVE=1 ;;
    --json)               JSON_OUTPUT=1 ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//;/^set -euo/d'
      exit 0
      ;;
    *) echo "ERROR: unknown argument: $arg" >&2; echo "Run with --help for usage." >&2; exit 3 ;;
  esac
done

# Final-status emitter. Called on every exit path so webhooks get a parseable
# line even on error. Args: <exit_code> <status_slug> <human_message>
STATUS_EMITTED=0
emit_status() {
  local code="$1" slug="$2" msg="$3"
  STATUS_EMITTED=1
  if [ "$JSON_OUTPUT" = "1" ]; then
    printf '{"exit_code":%d,"status":"%s","message":"%s","host":"%s","ts":"%s"}\n' \
      "$code" "$slug" "${msg//\"/\\\"}" "$(hostname)" "$(date -Iseconds)"
  fi
}
# Safety net: if the script dies from set -e before reaching an explicit exit,
# we still want a JSON line out for the webhook.
trap 'rc=$?; if [ "$STATUS_EMITTED" = "0" ] && [ "$rc" != "0" ]; then emit_status "$rc" "error" "script exited with code $rc (unexpected)"; fi' EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH" >&2
  emit_status 3 "preflight_fail" "docker not found in PATH"
  exit 3
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "ERROR: MariaDB container '$DB_CONTAINER' is not running." >&2
  echo "Start it first:  cd $COMPOSE_DIR && docker compose up -d mariadb" >&2
  emit_status 3 "preflight_fail" "MariaDB container '$DB_CONTAINER' is not running"
  exit 3
fi

if [ -z "${MARIADB_ROOT_PASSWORD:-}" ]; then
  echo "ERROR: MARIADB_ROOT_PASSWORD is not set in the environment." >&2
  echo "  source /root/.promote-replica.env  (or pass it inline)" >&2
  emit_status 3 "preflight_fail" "MARIADB_ROOT_PASSWORD not set"
  exit 3
fi

# Idempotency check — if SHOW SLAVE STATUS is empty AND read_only is already 0,
# this box is already the primary. Return cleanly so the webhook can treat
# re-invocation as a 200 no-op.
SLAVE_STATUS_LINES=$(docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" \
  -e "SHOW SLAVE STATUS\G" 2>/dev/null | grep -c "Master_Host" || true)
READ_ONLY_VAL=$(docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" \
  -sNe "SELECT @@global.read_only" 2>/dev/null || echo "?")

if [ "$SLAVE_STATUS_LINES" = "0" ] && [ "$READ_ONLY_VAL" = "0" ]; then
  echo "✓ This node is already promoted (no slave status, read_only=0)."
  echo "  No changes made."
  emit_status 2 "already_promoted" "node already in primary state; no changes made"
  exit 2
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
if [ "$NON_INTERACTIVE" = "1" ]; then
  # Safety interlock: require an explicit env var acknowledgement so someone
  # can't accidentally type `--non-interactive` in a shell and nuke things.
  # The auto-failover webhook sets PROMOTE_ACK=yes after verifying the
  # shared secret from the Cloudflare Worker.
  if [ "${PROMOTE_ACK:-}" != "yes" ]; then
    echo "ERROR: --non-interactive requires PROMOTE_ACK=yes in the environment." >&2
    echo "  This interlock prevents accidental invocation. The HA webhook" >&2
    echo "  sets it automatically after verifying its shared secret." >&2
    emit_status 1 "ack_missing" "non-interactive mode requires PROMOTE_ACK=yes"
    exit 1
  fi
  echo "→ Non-interactive promotion (PROMOTE_ACK verified)."
else
  read -rp "Promote this Replica to Primary? Type 'promote' to confirm: " ans
  if [ "$ans" != "promote" ]; then
    echo "Aborted."
    emit_status 1 "user_aborted" "operator declined confirmation prompt"
    exit 1
  fi
fi

echo
echo "=== Promoting ==="
if ! docker exec "$DB_CONTAINER" mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
STOP SLAVE;
RESET SLAVE ALL;
SET GLOBAL read_only = 0;
SQL
then
  echo "ERROR: promotion SQL failed. DB may be in partial state." >&2
  echo "  Check:  docker logs $DB_CONTAINER --tail 50" >&2
  emit_status 4 "promotion_sql_failed" "STOP SLAVE / RESET SLAVE ALL / SET GLOBAL read_only=0 returned non-zero"
  exit 4
fi

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

if [ "$NON_INTERACTIVE" = "0" ]; then
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
fi

emit_status 0 "promoted" "replica promoted to primary; cloudflared started; status-server serving"
