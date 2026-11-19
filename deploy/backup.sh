#!/usr/bin/env bash
# Writes a compressed dump of the database to ~/opsdesk-backups and keeps the
# last 14. Meant for cron, once a day:
#   15 3 * * * /home/opsdesk/OpsDesk/deploy/backup.sh >> /home/opsdesk/backup.log 2>&1
#
# Restore into an empty database:
#   docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec -T postgres \
#     pg_restore -U opsdesk_owner -d opsdesk --clean --if-exists < FILE.dump
#
# A backup on the same server does not survive losing the server. Copy the
# files somewhere else too (another machine, or object storage).
set -euo pipefail
cd "$(dirname "$0")/.."

dir="${BACKUP_DIR:-$HOME/opsdesk-backups}"
mkdir -p "$dir"
file="$dir/opsdesk-$(date -u +%Y%m%dT%H%M%SZ).dump"

# -Fc: PostgreSQL's own compressed format, restored with pg_restore.
# The dump is written to a temporary name first, so a failed run never leaves
# a half-written file that looks like a good backup.
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$file.partial"
mv "$file.partial" "$file"

ls -1t "$dir"/opsdesk-*.dump | tail -n +15 | xargs -r rm --
echo "backup written: $file ($(du -h "$file" | cut -f1))"
