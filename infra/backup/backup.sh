#!/usr/bin/env bash
# Daily backup of the Postgres database + Supabase Storage buckets into an
# encrypted, deduplicating restic repository.
#
# Schedule (driven by hikyaku-backup.timer, or cron): runs once a day. The
# 1st of each month -- or the very first run against an empty repo, or
# FORCE_FULL=1 -- is tagged "full"; every other day is tagged "incremental".
# restic content-defines chunks and dedupes against everything already in
# the repo, so a full and an incremental run do the same work either way;
# only the tag differs, and the retention policy below keys off that tag.
#
# Requires on PATH: restic, rclone, pg_dump, jq, flock.
# Config: see backup.env.example.

set -euo pipefail
umask 077

ENV_FILE="${BACKUP_ENV_FILE:-/etc/hikyaku-backup/backup.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (see backup.env.example)}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE not set}"
: "${DB_BACKUP_URL:?DB_BACKUP_URL not set}"
: "${RCLONE_CONFIG_SUPASTORAGE_ENDPOINT:?RCLONE_CONFIG_SUPASTORAGE_ENDPOINT not set}"
: "${RCLONE_CONFIG_SUPASTORAGE_ACCESS_KEY_ID:?RCLONE_CONFIG_SUPASTORAGE_ACCESS_KEY_ID not set}"
: "${RCLONE_CONFIG_SUPASTORAGE_SECRET_ACCESS_KEY:?RCLONE_CONFIG_SUPASTORAGE_SECRET_ACCESS_KEY not set}"

STAGING_DIR="${BACKUP_STAGING_DIR:-/var/backups/hikyaku/staging}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/var/backups/hikyaku/backup.lock}"
RETENTION_FULL_MONTHS="${RETENTION_FULL_MONTHS:-6}"
RETENTION_INCREMENTAL_DAYS="${RETENTION_INCREMENTAL_DAYS:-35}"
RESTIC_HOST="hikyaku-backup"

export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

log() { echo "[$(date -Is)] $*"; }

# Prevent overlapping runs -- a slow storage sync could still be going when
# the next scheduled run fires.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another backup run is already in progress, exiting"
  exit 1
fi

if ! restic snapshots >/dev/null 2>&1; then
  log "no repository found at $RESTIC_REPOSITORY, initializing"
  restic init
fi

is_first_run=false
if ! restic snapshots --host "$RESTIC_HOST" --json | jq -e 'length > 0' >/dev/null 2>&1; then
  is_first_run=true
fi

tag=incremental
if [ "$is_first_run" = true ] || [ "$(date +%d)" = "01" ] || [ "${FORCE_FULL:-0}" = "1" ]; then
  tag=full
fi
log "starting $tag backup"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/db" "$STAGING_DIR/storage"
trap 'rm -rf "$STAGING_DIR"' EXIT

log "dumping Postgres database"
# --compress=0: let restic's own chunking/compression dedupe consecutive
# dumps instead of pg_dump's gzip, which would make every dump look
# unrelated at the byte level even when the underlying data barely changed.
pg_dump "$DB_BACKUP_URL" \
  --format=custom --compress=0 --no-owner --no-privileges \
  --file="$STAGING_DIR/db/hikyaku-$(date +%Y%m%d-%H%M%S).dump"

log "syncing Supabase Storage buckets"
# RCLONE_CONFIG_SUPASTORAGE_* is already in the environment (from backup.env
# or the container/systemd env) -- rclone reads it directly, nothing to
# wire up here. Keeping these as real rclone env vars, rather than
# backup.sh-specific names it translates, is what lets a plain
# `docker compose exec backup rclone ...` also work during a restore.

if [ -n "${STORAGE_BUCKETS:-}" ]; then
  IFS=',' read -ra buckets <<< "$STORAGE_BUCKETS"
else
  mapfile -t buckets < <(rclone lsd supastorage: | awk '{print $NF}')
fi

for bucket in "${buckets[@]}"; do
  log "  bucket: $bucket"
  rclone sync "supastorage:${bucket}" "$STAGING_DIR/storage/${bucket}"
done

log "writing snapshot to restic repository"
restic backup "$STAGING_DIR" --host "$RESTIC_HOST" --tag "$tag" --tag hikyaku

log "applying retention (full: ${RETENTION_FULL_MONTHS}mo, incremental: ${RETENTION_INCREMENTAL_DAYS}d)"
restic forget --host "$RESTIC_HOST" --tag full --keep-within "${RETENTION_FULL_MONTHS}m"
restic forget --host "$RESTIC_HOST" --tag incremental --keep-within "${RETENTION_INCREMENTAL_DAYS}d"
restic prune

log "$tag backup complete"
