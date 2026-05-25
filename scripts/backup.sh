#!/usr/bin/env bash
# Nightly backup: pg_dump + assets tarball → Backblaze B2 via rclone.
# Add to host crontab (NOT inside the container):
#   0 3 * * * /opt/content-automation/scripts/backup.sh >> /var/log/ca-backup.log 2>&1

set -euo pipefail

cd "$(dirname "$0")/.."

STAMP=$(date -u +%Y-%m-%d_%H%M)
BACKUP_DIR="${BACKUP_DIR:-/var/backups/content-automation}"
mkdir -p "$BACKUP_DIR"

source ./.env

# 1. Postgres dump
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

# 2. Assets tarball (small enough to do daily until > 5 GB)
tar -C /var/lib/docker/volumes \
    -czf "$BACKUP_DIR/assets-$STAMP.tar.gz" \
    --warning=no-file-changed \
    content-automation_assets/_data || true

# 3. Push to Backblaze B2 (requires `rclone config` set up with a remote named "b2")
if command -v rclone >/dev/null && [ -n "${B2_BUCKET:-}" ]; then
  rclone copy "$BACKUP_DIR/db-$STAMP.sql.gz"     "b2:$B2_BUCKET/db/"
  rclone copy "$BACKUP_DIR/assets-$STAMP.tar.gz" "b2:$B2_BUCKET/assets/"
fi

# 4. Retention: keep 7 days locally
find "$BACKUP_DIR" -mtime +7 -delete

echo "Backup complete: $STAMP"
