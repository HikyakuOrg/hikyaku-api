#!/usr/bin/env bash
# Read-only helper: lists restic snapshots so you can check backup health
# without memorizing restic flags or the repository path. Safe to run any
# time -- it never modifies the repository.
#
# Usage:
#   ./list-snapshots.sh              # table view
#   ./list-snapshots.sh --json       # machine-readable
#   ./list-snapshots.sh --tag full   # only monthly full snapshots

set -euo pipefail

ENV_FILE="${BACKUP_ENV_FILE:-/etc/hikyaku-backup/backup.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (see backup.env.example)}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE not set}"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

restic snapshots --host hikyaku-backup "$@"
