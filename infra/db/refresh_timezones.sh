#!/usr/bin/env bash
# Requires:
# - curl
# - unzip
# - psql (Postgres client)
# - ogr2ogr (GDAL)
#
# CI/CD: set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD as env vars.
# Interactive: leave them unset and the script will prompt.

set -euo pipefail

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

DB_SCHEMA="tzdata"
DB_TABLE="timezone"

# ===== SETUP =====
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Working in temp directory: $TMP_DIR"
cd "$TMP_DIR"

# ===== GET LATEST RELEASE =====
echo "Fetching latest release info..."

RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/evansiroky/timezone-boundary-builder/releases/latest")

ZIP_URL=$(echo "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*timezones-1970\.geojson\.zip"' | grep -o 'https://[^"]*' | head -1)

if [ -z "$ZIP_URL" ]; then
  echo "Error: Could not find timezones-1970.geojson.zip in latest release" >&2
  exit 1
fi

echo "Downloading: $ZIP_URL"
curl -fL "$ZIP_URL" -o timezones.zip

# ===== UNZIP =====
echo "Unzipping..."
unzip -q timezones.zip

GEOJSON_FILE=$(find . -name "combined-1970.json" | head -1)

if [ -z "$GEOJSON_FILE" ]; then
  echo "Files found in temp dir:"
  find . -type f
  echo "Error: GeoJSON file not found" >&2
  exit 1
fi

echo "Found GeoJSON: $GEOJSON_FILE"

# ===== TRUNCATE TABLE =====
echo "Truncating table ${DB_SCHEMA}.${DB_TABLE}..."

psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -c "TRUNCATE TABLE ${DB_SCHEMA}.${DB_TABLE};"

# ===== IMPORT VIA OGR2OGR =====
echo "Importing via ogr2ogr..."

PG_CONN="host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME} user=${DB_USER} password=${DB_PASSWORD} sslmode=require"

ogr2ogr \
  -f "PostgreSQL" \
  "PG:${PG_CONN}" \
  "$GEOJSON_FILE" \
  -nln "${DB_SCHEMA}.${DB_TABLE}" \
  -append \
  -nlt PROMOTE_TO_MULTI \
  -lco GEOMETRY_NAME=geom \
  -t_srs EPSG:4326 \
  -progress \
  --config PG_USE_COPY YES

echo "Done."
