-- Replaces package_timeline's bigint identity "id" with a time-ordered
-- UUIDv7 primary key, and adds the table to the supabase_realtime
-- publication.
--
-- Why UUIDv7 (not v4): get_packages_count(), package_latest_status(), the
-- driver-manifest function, and DatabaseService's vehicle-idle-time query
-- (src/database/database.service.ts) all resolve "latest status for this
-- package" via ORDER BY pt.created_at DESC, pt.id DESC — the bigint id is
-- there purely as a deterministic tie-break for rows that share the exact
-- same created_at (e.g. two statuses landing in the same batch/transaction).
-- A random v4 UUID would make that tie-break arbitrary. UUIDv7 embeds a
-- millisecond timestamp in its leading bits, so plain byte-wise comparison
-- ("id DESC") still approximates insertion order, and none of that
-- downstream SQL needs to change — it keeps referencing "pt.id" by name.
--
-- No pg_uuidv7 extension or native uuidv7() (PG18+) is installed on this
-- database, so this defines a pure-SQL generator (layout adapted from
-- https://postgresql.verite.pro/blog/2024/07/15/uuid-v7-pure-sql.html).
--
-- Locking note: the backfill UPDATE below rewrites every existing row and
-- runs under the ACCESS EXCLUSIVE lock ALTER TABLE already holds, so this
-- migration blocks reads/writes to package_timeline for its full duration.
-- Run it in a low-traffic window; consider "VACUUM (ANALYZE) package_timeline"
-- afterwards (outside this migration — VACUUM cannot run in a transaction).

-- 1. Permanent generator, used as the new column's DEFAULT for all future
--    inserts. 48-bit ms timestamp (clock_timestamp) + 12-bit sub-ms
--    fraction (keeps rapid successive inserts ordered) + 62 random bits.
CREATE OR REPLACE FUNCTION "public"."uuid_generate_v7"() RETURNS "uuid"
    LANGUAGE "sql" VOLATILE
    SET "search_path" TO 'public', 'extensions'
    AS $$
    SELECT encode(
        substring(int8send(floor(t_ms)::int8) FROM 3) ||
        int2send((7 << 12)::int2 | ((t_ms - floor(t_ms)) * 4096)::int2) ||
        substring(uuid_send(gen_random_uuid()) FROM 9 FOR 8),
        'hex')::uuid
    FROM (SELECT extract(epoch FROM clock_timestamp()) * 1000 AS t_ms) s;
$$;

COMMENT ON FUNCTION "public"."uuid_generate_v7"() IS
    'Time-ordered UUIDv7 (RFC 9562) generator: 48-bit ms timestamp, 12-bit sub-ms fraction, 62 random bits. Pure-SQL because no native uuidv7()/pg_uuidv7 extension is available on this Postgres version.';

-- 2. One-off backfill generator: same byte layout, but takes the row's own
--    created_at (instead of "now") and derives the 12-bit sub-ms slot from
--    the row's *old* bigint id instead of a random fraction. This makes the
--    backfilled uuid preserve the exact relative order the old
--    "created_at DESC, id DESC" tie-break already relied on, instead of
--    collapsing every historical row onto ~the same migration-run-time
--    timestamp. Single-use — dropped again at the end of this migration.
CREATE FUNCTION "public"."package_timeline_uuid_v7_backfill"("p_created_at" timestamp with time zone, "p_legacy_id" bigint) RETURNS "uuid"
    LANGUAGE "sql" VOLATILE
    SET "search_path" TO 'public', 'extensions'
    AS $$
    SELECT encode(
        substring(int8send(floor(t_ms)::int8) FROM 3) ||
        int2send((7 << 12)::int2 | (p_legacy_id & 4095)::int2) ||
        substring(uuid_send(gen_random_uuid()) FROM 9 FOR 8),
        'hex')::uuid
    FROM (SELECT extract(epoch FROM p_created_at) * 1000 AS t_ms) s;
$$;

-- 3. Add the new uuid column and backfill it, preserving order.
ALTER TABLE "public"."package_timeline" ADD COLUMN "id_uuid" "uuid";

UPDATE "public"."package_timeline"
SET "id_uuid" = "public"."package_timeline_uuid_v7_backfill"("created_at", "id");

ALTER TABLE "public"."package_timeline" ALTER COLUMN "id_uuid" SET NOT NULL;
ALTER TABLE "public"."package_timeline" ALTER COLUMN "id_uuid" SET DEFAULT "public"."uuid_generate_v7"();

-- 4. Swap the primary key. Dropping "id" (an IDENTITY column) also drops its
--    owned sequence (package_timeline_id_seq, incl. its anon/authenticated/
--    service_role grants) and package_timeline_pkg_created_idx, since both
--    depend solely on this column — no CASCADE needed, and no other object
--    depends on package_timeline.id (verified: no FKs reference it, and
--    packages_with_latest_status, the only view over this table, does not
--    select it).
ALTER TABLE "public"."package_timeline" DROP CONSTRAINT "package_timeline_pkey";
ALTER TABLE "public"."package_timeline" DROP COLUMN "id";
ALTER TABLE "public"."package_timeline" RENAME COLUMN "id_uuid" TO "id";
ALTER TABLE "public"."package_timeline" ADD CONSTRAINT "package_timeline_pkey" PRIMARY KEY ("id");

-- Recreated against the new uuid "id" — same name, same shape, so the three
-- functions ordering by "pt.created_at DESC, pt.id DESC" keep using it as-is.
CREATE INDEX "package_timeline_pkg_created_idx"
    ON "public"."package_timeline" USING "btree" ("package_id", "created_at" DESC, "id" DESC);

-- 5. Backfill helper was single-use; remove it.
DROP FUNCTION "public"."package_timeline_uuid_v7_backfill"(timestamp with time zone, bigint);

-- 6. Enable Supabase Realtime (same mechanism already used for
--    driver_current_location).
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."package_timeline";
