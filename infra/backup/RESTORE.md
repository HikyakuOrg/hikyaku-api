# Restoring from a backup

There is deliberately no one-shot "restore" script. Restoring is rare,
high-stakes, and the two halves (database, storage) usually need to land in a
scratch environment first so you can verify them before anything touches
production. Follow these steps manually.

Commands below assume the Docker setup, run from `infra/backup/` (the
directory with `docker-compose.yml`), since `restic`/`rclone`/`pg_restore`
already live in that container -- nothing extra to install. Running without
Docker? Drop the `docker compose exec backup` prefix and run the same
commands directly on the host instead, after `source
/etc/hikyaku-backup/backup.env` (or exporting `RESTIC_REPOSITORY` /
`RESTIC_PASSWORD_FILE` yourself).

## 1. Find the snapshot you want

```bash
docker compose exec backup /app/list-snapshots.sh              # all snapshots, newest last
docker compose exec backup /app/list-snapshots.sh --tag full   # only the monthly full ones
```

Note the snapshot ID (short hex, e.g. `a1b2c3d4`) you want to restore.

## 2. Extract it to a scratch directory

This only reads from the repository -- it cannot damage existing backups.
Restoring into the bind-mounted backup directory means the extracted files
are also reachable from the host afterwards, at the same path.

```bash
docker compose exec backup restic restore a1b2c3d4 --target /var/backups/hikyaku/restore
```

You'll get `/var/backups/hikyaku/restore/var/backups/hikyaku/staging/{db,storage}/...`
(restic preserves the original absolute path from inside the container)
containing the `.dump` file and the synced storage buckets from that
snapshot.

## 3. Restore the database -- into a scratch target first

**Do not restore directly into the production project.** Create a fresh
Supabase project (or a local/throwaway Postgres) and restore there first:

```bash
docker compose exec backup pg_restore --no-owner --no-privileges --clean --if-exists \
  -d "postgresql://<user>:<password>@<scratch-host>:5432/postgres" \
  /var/backups/hikyaku/restore/var/backups/hikyaku/staging/db/hikyaku-*.dump
```

If this is a full disaster-recovery restore (not just recovering one table),
restore into a **brand-new** Supabase project rather than one with its own
existing `auth`/`storage` data -- the dump includes Supabase's internal
schemas (`auth`, `storage`, `realtime`, etc.), and those conflict with
whatever a non-empty project already has. This mirrors Supabase's own
documented pg_dump/pg_restore recovery path.

If you only need your own application data back (e.g. seeding a dev
environment, not full DR), restore just the app-owned schemas instead:

```bash
docker compose exec backup pg_restore --no-owner --no-privileges --clean --if-exists \
  --schema=public --schema=stripe --schema=tzdata --schema=hikyaku_migrations \
  -d "<target-url>" /var/backups/hikyaku/restore/.../db/hikyaku-*.dump
```

Once you've checked the scratch restore looks right, point the app at it (or
migrate the verified data into production deliberately) -- don't skip the
verification step under time pressure.

## 4. Restore storage buckets -- copy, don't sync, into anything live

The `supastorage:` rclone remote is already configured inside the container
via the `RCLONE_CONFIG_SUPASTORAGE_*` vars in `backup.env`, so you can invoke
`rclone` directly:

```bash
docker compose exec backup rclone copy \
  /var/backups/hikyaku/restore/.../storage/org-logos supastorage:org-logos
```

Use `copy`, not `sync`, when the destination bucket already has objects you
want to keep -- `sync` makes the destination exactly match the source,
**deleting** anything at the destination that isn't in the source. Only use
`sync` if you specifically want to roll the bucket back to exactly this
snapshot's state.

## 5. Clean up

```bash
docker compose exec backup rm -rf /var/backups/hikyaku/restore
```

The extracted dump/files are plaintext -- don't leave them sitting around
longer than the restore takes.
