#!/usr/bin/env bash
# restore.sh — Restore Applegate Monitor database from a backup file
#
# Usage:
#   ./restore.sh backups/status_monitor_20260412_020000.sql.gz
#
# This will DROP and recreate the database, then import the dump.
# The status-server container will reconnect automatically once the
# restore is complete.

set -euo pipefail

# ── Config (same as backup.sh — override via env vars or .backup.env) ────────
DB_CONTAINER="${DB_CONTAINER:-mariadb}"
DB_NAME="${DB_NAME:-status_monitor}"
DB_USER="${DB_USER:-statusadmin}"
DB_PASS="${DB_PASS:-}"
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.backup.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

if [[ -z "$DB_PASS" ]]; then
  echo "[error] DB_PASS is not set. See backup.sh for setup instructions."
  exit 1
fi

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <backup-file.sql.gz>"
  echo ""
  echo "Available backups:"
  ls -lh "$SCRIPT_DIR/backups/"*.sql.gz 2>/dev/null || echo "  (none found in $SCRIPT_DIR/backups/)"
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[error] File not found: $BACKUP_FILE"
  exit 1
fi

if ! docker inspect --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
  echo "[error] Container '$DB_CONTAINER' is not running."
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restoring '$DB_NAME' from: $(basename "$BACKUP_FILE")"
echo "[warn]  This will DROP and recreate the '$DB_NAME' database."
read -r -p "         Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Dropping and recreating database..."
docker exec "$DB_CONTAINER" \
  mysql -u"$DB_USER" -p"$DB_PASS" \
  -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Importing dump..."
gunzip -c "$BACKUP_FILE" | docker exec -i "$DB_CONTAINER" \
  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restore complete. Restart status-server if it is not running:"
echo "         docker compose up -d"
