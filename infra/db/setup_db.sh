#!/usr/bin/env bash
# Requires:
# - psql (Postgres client)
#
# Use the DIRECT connection string from Supabase (Project Settings → Database
# → Connection string → URI), not the pooler. DDL and ALTER ROLE require a
# direct session. Default direct port is 5432; the pooler uses 6543.
#
# CI/CD: set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD as env vars.
# Interactive: leave them unset and the script will prompt.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ===== INPUT (env vars take precedence; fall back to interactive prompts) =====
if [ -z "${DB_HOST:-}" ]; then
  read -rp "Enter DB_HOST (e.g. db.<project-ref>.supabase.co): " DB_HOST
fi
if [ -z "${DB_PORT:-}" ]; then
  read -rp "Enter DB_PORT (default: 5432): " DB_PORT
fi
DB_PORT="${DB_PORT:-5432}"
if [ -z "${DB_NAME:-}" ]; then
  read -rp "Enter DB_NAME (default: postgres): " DB_NAME
fi
DB_NAME="${DB_NAME:-postgres}"
if [ -z "${DB_USER:-}" ]; then
  read -rp "Enter DB_USER (default: postgres): " DB_USER
fi
DB_USER="${DB_USER:-postgres}"
if [ -z "${DB_PASSWORD:-}" ]; then
  read -rsp "Enter DB_PASSWORD: " DB_PASSWORD
  echo
fi

export PGPASSWORD="$DB_PASSWORD"

psql_cmd() {
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
}

echo "Applying roles.sql..."
psql_cmd -f "$SCRIPT_DIR/roles.sql"

echo "Applying schema.sql..."
psql_cmd -f "$SCRIPT_DIR/schema.sql"

echo "Applying seed.sql..."
psql_cmd -f "$SCRIPT_DIR/seed.sql"

echo "Database setup complete."
