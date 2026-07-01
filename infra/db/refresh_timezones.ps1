# Requires:
# - curl (built-in on modern Windows)
# - unzip (Expand-Archive)
# - psql (Postgres client)
# - ogr2ogr (GDAL)

$ErrorActionPreference = "Stop"

# ===== INTERACTIVE INPUT =====
$DB_HOST = Read-Host "Enter DB_HOST (e.g. aws-1-ap-south-1.pooler.supabase.com)"
$DB_PORT = Read-Host "Enter DB_PORT (default: 6543)"
if ([string]::IsNullOrWhiteSpace($DB_PORT)) { $DB_PORT = "6543" }

$DB_NAME = Read-Host "Enter DB_NAME (e.g. postgres)"
$DB_USER = Read-Host "Enter DB_USER"
$DB_PASSWORD = Read-Host "Enter DB_PASSWORD"

$DB_SCHEMA = "tzdata"
$DB_TABLE = "timezone"

# ===== SETUP =====
$TMP_DIR = "$env:TEMP\timezones"

Write-Host "Cleaning temp directory..."
if (Test-Path $TMP_DIR) {
    Remove-Item -Recurse -Force $TMP_DIR
}
New-Item -ItemType Directory -Path $TMP_DIR | Out-Null
Set-Location $TMP_DIR

# ===== GET LATEST RELEASE =====
Write-Host "Fetching latest release info..."

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/evansiroky/timezone-boundary-builder/releases/latest"

$asset = $release.assets | Where-Object {
    $_.browser_download_url -like "*timezones-1970.geojson.zip"
} | Select-Object -First 1

if (-not $asset) {
    Write-Error "Could not find timezones-1970.geojson.zip in latest release"
    exit 1
}

$zipUrl = $asset.browser_download_url
Write-Host "Downloading: $zipUrl"

Invoke-WebRequest -Uri $zipUrl -OutFile "timezones.zip"

# ===== UNZIP =====
Write-Host "Unzipping..."
Expand-Archive -Path "timezones.zip" -DestinationPath "." -Force

$geojsonFile = Get-ChildItem -Recurse -Filter "combined-1970.json" | Select-Object -First 1

if (-not $geojsonFile) {
    Write-Host "Files found in temp dir:"
    Get-ChildItem -Recurse | Select-Object -ExpandProperty FullName
    Write-Error "GeoJSON file not found"
    exit 1
}

Write-Host "Found GeoJSON: $($geojsonFile.FullName)"

# ===== TRUNCATE TABLE =====
Write-Host "Truncating table $DB_SCHEMA.$DB_TABLE..."

$env:PGPASSWORD = $DB_PASSWORD

psql `
  -h $DB_HOST `
  -p $DB_PORT `
  -U $DB_USER `
  -d $DB_NAME `
  -c "TRUNCATE TABLE $DB_SCHEMA.$DB_TABLE;"

# ===== IMPORT VIA OGR2OGR =====
Write-Host "Importing via ogr2ogr..."

$PG_CONN = "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$DB_USER password=$DB_PASSWORD sslmode=require"

ogr2ogr `
  -f "PostgreSQL" `
  "PG:$PG_CONN" `
  "$($geojsonFile.FullName)" `
  -nln "$DB_SCHEMA.$DB_TABLE" `
  -append `
  -nlt PROMOTE_TO_MULTI `
  -lco GEOMETRY_NAME=geom `
  -t_srs EPSG:4326 `
  -progress `
  --config PG_USE_COPY YES

Write-Host "Done."