#!/usr/bin/env bash
# backup.sh — MariaDB backup for Applegate Monitor
#
# Dumps the status_monitor database from the running MariaDB container,
# gzips it, saves it to ./backups/, and prunes files older than KEEP_DAYS.
#
# ── Quick start ──────────────────────────────────────────────────────────────
#   1. Create a .backup.env file next to this script (it's gitignored):
#
#        echo 'DB_PASS=your_password_here' > .backup.env
#
#   2. Make executable and test:
#        chmod +x backup.sh
#        ./backup.sh
#
#   3. Schedule with cron (daily at 02:00):
#        crontab -e
#        0 2 * * * /mnt/volumes/WDBlue2TB/status-server/backup.sh >> /var/log/status-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config (override via env vars or .backup.env) ────────────────────────────
DB_CONTAINER="${DB_CONTAINER:-mariadb}"           # Docker container name for MariaDB
DB_NAME="${DB_NAME:-status_monitor}"              # Database to dump
DB_USER="${DB_USER:-statusadmin}"                 # DB username
DB_PASS="${DB_PASS:-}"                            # DB password — set in .backup.env
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/backups}"  # Where to store backup files
KEEP_DAYS="${KEEP_DAYS:-7}"                       # Days of backups to keep (7 = 1 week)
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.backup.env"

# Load .backup.env if it exists — keeps credentials out of this script and git
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

# Hard stop if no password — better to fail loudly than produce an empty dump
if [[ -z "$DB_PASS" ]]; then
  echo "[error] DB_PASS is not set."
  echo "        Create $ENV_FILE with a single line:  DB_PASS=yourpassword"
  echo "        Or export DB_PASS=yourpassword before running this script."
  exit 1
fi

# Verify the target container is actually running before attempting the dump
if ! docker inspect --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
  echo "[error] Container '$DB_CONTAINER' is not running."
  exit 1
fi

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/status_monitor_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting backup of '$DB_NAME' from container '$DB_CONTAINER'..."

# --single-transaction: consistent snapshot without locking tables (InnoDB)
# --routines --triggers: include stored procedures/triggers if any
# --add-drop-table: safe to restore into a non-empty DB
docker exec "$DB_CONTAINER" \
  mysqldump \
    --single-transaction \
    --routines \
    --triggers \
    --add-drop-table \
    -u"$DB_USER" -p"$DB_PASS" \
    "$DB_NAME" \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Saved: $(basename "$BACKUP_FILE") ($SIZE)"

# Prune old backups
PRUNED=$(find "$BACKUP_DIR" -maxdepth 1 -name "status_monitor_*.sql.gz" -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null | wc -l)
if [[ "$PRUNED" -gt 0 ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pruned $PRUNED old backup(s) older than ${KEEP_DAYS} day(s)"
fi

# Print summary of all kept backups
COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name "status_monitor_*.sql.gz" | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done. $COUNT backup(s) stored in $BACKUP_DIR"
