# Hikyaku backups

Daily encrypted backup of the Postgres database (Supabase-hosted) and every
Supabase Storage bucket, running as a Docker container 24/7 (a bare-metal
systemd/cron path is also available -- see [Alternative](#alternative-running-without-docker)).

## Why it's built this way

- **Postgres is Supabase-hosted**, so there's no filesystem or replication
  access for physical/WAL-based tools (pgBackRest, WAL-G) -- Supabase
  doesn't grant that on hosted projects. The only backup path available is a
  logical dump (`pg_dump`) over the normal connection string.
- **"Incremental" is done by restic, not a Postgres-specific delta tool.**
  `backup.sh` runs a full `pg_dump` and a full Storage sync on *every* run,
  then hands both to `restic backup`. restic content-defines chunks and
  dedupes against everything already in the repository, so a day where
  almost nothing changed costs almost nothing to store -- without needing
  the database itself to support incremental export.
- **Encryption** is restic's, not a separate layer: every restic repository
  is AES-256 encrypted end-to-end (data and metadata) using the repository
  password. There's nothing extra to configure for "encryption is needed" --
  just don't lose the password (see below).
- **Full vs. incremental is just a tag.** The 1st of each month (or the very
  first run against an empty repo, or `FORCE_FULL=1`) is tagged `full`;
  every other day is tagged `incremental`. Retention is applied per tag, so
  full snapshots age out at 6 months independent of the dailies.
- **No cron daemon inside the container.** The image's `ENTRYPOINT` is
  [entrypoint.sh](entrypoint.sh), a loop that sleeps and checks the clock,
  running `backup.sh` once a day at `BACKUP_TIME`. That loop *is* the
  container's foreground process, which is what keeps it running 24/7 rather
  than exiting after one run. Cron inside containers is a well-known source
  of pain (lost environment variables, swallowed stdout, PID 1 signal
  handling) that isn't worth taking on for a single daily job.

## One-time setup (Docker)

1. **Get Supabase Storage S3 credentials**: Supabase dashboard -> Project
   Settings -> Storage -> S3 Connection. Generate a new access key pair
   dedicated to backups (don't reuse `SUPABASE_SERVICE_ROLE_KEY`).

2. **Generate the restic repository password** and save it somewhere durable
   (password manager, printed and locked away -- your choice, but
   *somewhere* outside this server):

   ```bash
   sudo mkdir -p /var/backups/hikyaku
   openssl rand -base64 48 | sudo tee /var/backups/hikyaku/restic-password > /dev/null
   sudo chmod 600 /var/backups/hikyaku/restic-password
   ```

   There is no recovery if this file and every copy of it are lost --
   restic's encryption has no back door.

   (This lives inside the bind-mounted `/var/backups/hikyaku` rather than
   `/etc` here, since that's the directory the container actually has
   read/write access to -- see `docker-compose.yml`'s `volumes:`.)

3. **Fill in the config**, next to `docker-compose.yml`:

   ```bash
   cd infra/backup
   cp backup.env.example backup.env
   chmod 600 backup.env
   ```

   Edit `backup.env`: fill in `DB_BACKUP_URL` and the `SUPABASE_S3_*`
   values, set `RESTIC_PASSWORD_FILE=/var/backups/hikyaku/restic-password`
   (matching step 2), and set `TZ`/`BACKUP_TIME` if you don't want the
   default UTC 03:15. Everything else already matches this compose file's
   paths.

4. **Build and start it:**

   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```

   The first run happens at the next `BACKUP_TIME` (or immediately, if
   you'd rather not wait -- see below). It initializes the restic repository
   and is always tagged `full`, regardless of the date.

5. **Trigger a run immediately** instead of waiting for the schedule, to
   confirm everything actually works before trusting it:

   ```bash
   docker compose exec backup /app/backup.sh
   ```

   Fix any errors (wrong credentials, unreachable DB, permission issues) --
   they'll show up here immediately rather than silently at 3am.

## Checking on it

```bash
docker compose ps                                    # is it up
docker compose logs --tail 200 backup                # recent scheduler + backup output
docker compose exec backup /app/list-snapshots.sh    # what's actually in the repository
```

A failed run is logged and retried at the next scheduled time; there's no
separate alerting wired up here. `restart: unless-stopped` (in
`docker-compose.yml`) brings the container back after a crash or host
reboot, and the entrypoint's "at or after `BACKUP_TIME`" check (not an exact
match) means a restart that lands after today's window still runs today's
backup right away instead of waiting for tomorrow.

## Restoring

See [RESTORE.md](RESTORE.md). It's a manual runbook, not a script --
restoring is rare enough and consequential enough that it shouldn't be one
command someone runs half-awake at 3am without reading it first.

## Known limitations

- **Local disk only, by design.** This backup lives on the same server it
  protects against logical mistakes (bad migration, accidental delete,
  app-level bug) -- it does **not** protect against that server's disk or
  host failing outright. Since a restic repository is just a directory of
  files, adding an offsite copy later is a one-line addition
  (`rclone sync /var/backups/hikyaku/restic-repo remote:hikyaku-backups`) and
  doesn't require changing anything above.
- **DB dump and Storage sync are not point-in-time consistent with each
  other.** They run sequentially, a few minutes apart, against a live
  system. A file referenced by a database row written mid-backup could be
  missing from that same snapshot. Acceptable for disaster recovery; not a
  substitute for transactional guarantees.
- **Every run re-transfers every Storage file from Supabase**, even unchanged
  ones -- `backup.sh` wipes the local staging copy before each run (so the
  only plaintext copy of your storage buckets ever sitting on disk is
  transient, for the few minutes a run takes) rather than keeping a
  persistent local mirror rclone could sync incrementally. restic still
  dedupes the *repository* storage cost of unchanged files; it's the
  Supabase egress/transfer time that doesn't shrink. If that becomes slow or
  costly as the buckets grow, the fix is a persistent mirror directory
  outside `BACKUP_STAGING_DIR` that never gets wiped -- ask if you want that
  swapped in; it trades this transient-plaintext property for faster runs.
- **A container restarted before `BACKUP_TIME`, after several days down,
  waits for `BACKUP_TIME` rather than catching up instantly** -- a few
  hours' delay in an already-rare scenario (see `entrypoint.sh`'s header
  comment). Not worth the extra logic to close for a once-a-day job.

## Alternative: running without Docker

A plain systemd timer (or cron) works identically, using the same
`backup.sh` and `backup.env` -- the script doesn't know or care which
scheduler invoked it.

1. **Install dependencies** on the host: `restic`, `rclone`, `jq`, and a
   `pg_dump`/`pg_restore` matching your Supabase project's Postgres version
   (e.g. `postgresql-client` via apt, or the PGDG repo for an exact
   version). restic often needs a release binary from
   https://github.com/restic/restic/releases if your distro's package is
   too old.

2. **Create a dedicated system user and directories:**

   ```bash
   sudo useradd --system --home /var/backups/hikyaku --create-home hikyaku-backup
   sudo mkdir -p /var/backups/hikyaku/{restic-repo,staging} /etc/hikyaku-backup
   sudo chown -R hikyaku-backup:hikyaku-backup /var/backups/hikyaku /etc/hikyaku-backup
   sudo chmod 700 /etc/hikyaku-backup
   ```

3. **Generate the restic password and fill in config** as in the Docker
   steps above, but write them to `/etc/hikyaku-backup/restic-password` and
   `/etc/hikyaku-backup/backup.env` (chmod 600, owned by `hikyaku-backup`)
   instead -- `RESTIC_PASSWORD_FILE` in `backup.env.example` already
   defaults to that path. The `BACKUP_TIME`/`TZ`/`LAST_RUN_MARKER` vars at
   the bottom of `backup.env.example` are Docker-only (the scheduler here is
   the timer below instead) and can be left as-is; they're unused.

4. **Run it once by hand**, then install the timer:

   ```bash
   chmod +x infra/backup/backup.sh infra/backup/list-snapshots.sh
   sudo -u hikyaku-backup BACKUP_ENV_FILE=/etc/hikyaku-backup/backup.env infra/backup/backup.sh

   # update ExecStart= in hikyaku-backup.service to wherever this repo (or
   # just infra/backup/) lives on this host, then:
   sudo cp infra/backup/hikyaku-backup.service infra/backup/hikyaku-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now hikyaku-backup.timer
   ```

   Prefer cron instead of systemd? Skip the timer and add a line like
   `15 3 * * * hikyaku-backup BACKUP_ENV_FILE=/etc/hikyaku-backup/backup.env /opt/hikyaku-api/infra/backup/backup.sh`
   to `/etc/cron.d/hikyaku-backup`.

   Check on it with `systemctl list-timers hikyaku-backup.timer` and
   `journalctl -u hikyaku-backup.service`.
