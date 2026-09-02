#!/usr/bin/env bash
# Keeps the container running 24/7 and triggers backup.sh once a day at or
# after BACKUP_TIME. A plain loop rather than a cron daemon -- for one daily
# job this is simpler and sidesteps cron's well-known env-var/stdout/signal
# quirks inside containers.
#
# "At or after" rather than an exact time match means a restart that lands
# after today's scheduled time (redeploy, host reboot, brief outage) still
# runs today's backup right away instead of waiting up to 24h for the next
# window. The one gap: if the container is started *before* BACKUP_TIME
# after several days down, it waits for BACKUP_TIME rather than catching up
# immediately -- acceptable for a daily job, see README.md.

set -uo pipefail
# Not `-e`: a failed run should be logged and retried tomorrow, not kill the
# loop that's supposed to keep retrying.

BACKUP_TIME="${BACKUP_TIME:-03:15}"
LAST_RUN_MARKER="${LAST_RUN_MARKER:-/var/backups/hikyaku/last-run-date}"
CHECK_INTERVAL_SECONDS=60

log() { echo "[$(date -Is)] $*"; }

log "scheduler starting, target time ${BACKUP_TIME} $(date +%Z)"

while true; do
  today="$(date +%F)"
  now="$(date +%H:%M)"
  last_run="$(cat "$LAST_RUN_MARKER" 2>/dev/null || true)"

  if [[ "$last_run" != "$today" ]] && { [[ "$now" == "$BACKUP_TIME" ]] || [[ "$now" > "$BACKUP_TIME" ]]; }; then
    log "running backup.sh"
    if /app/backup.sh; then
      echo "$today" > "$LAST_RUN_MARKER"
      log "backup.sh finished OK"
    else
      status=$?
      log "backup.sh failed (exit $status) -- will try again at the next check"
    fi
  fi

  sleep "$CHECK_INTERVAL_SECONDS"
done
