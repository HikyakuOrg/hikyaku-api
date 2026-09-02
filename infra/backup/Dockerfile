# restic 0.16.4 and rclone are both in Alpine's community repo as of 3.20 --
# verified before pinning this tag rather than assumed.
FROM alpine:3.20

# restic/rclone: encrypted, deduplicating backup transport (see README.md).
# postgresql16-client: pg_dump + pg_restore, matching the client version
# infra/db/docker-compose.yml already uses against this project's Supabase.
# util-linux: flock, used by backup.sh to prevent overlapping runs.
# coreutils: GNU date -- BusyBox's date -d parsing is narrower than what
# entrypoint.sh relies on for the last-run-marker comparison.
RUN apk add --no-cache \
    bash \
    restic \
    rclone \
    postgresql16-client \
    jq \
    util-linux \
    coreutils \
    tzdata \
    ca-certificates

WORKDIR /app
COPY backup.sh list-snapshots.sh entrypoint.sh ./
RUN chmod +x backup.sh list-snapshots.sh entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
