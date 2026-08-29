-- Four small pieces of bookkeeping the assignment engine needs.
--
-- 1. packages.eviction_count -- the anti-starvation counter. A package with no
--    deadline can be bumped off a shift to make room for one that has a
--    deadline; without a counter that is unbounded, and a warehouse with steady
--    deadline traffic would bump the same parcel forever.
--
-- 2. warehouse.timezone -- kills the scheduler's in-memory timezone cache. The
--    nightly cron ran a PostGIS point-in-polygon join against tzdata.timezone
--    every hour and cached the answer in the Node process. Instant assignment
--    needs the warehouse-local date on every package creation, so the answer
--    becomes a column maintained by a trigger, and the hot path is a column
--    read. tzdata is not dropped -- it is promoted from a cache source to the
--    trigger's input.
--
-- 3. UNIQUE(driver_id, vehicle_id) on driver_vehicle_assignment -- the "free
--    driver/vehicle pair" query joins through this table, and duplicates make
--    one idle pair look like several.
--
-- 4. vrp_optimization_revision -- the audit trail that lets Tier 2 rewrite a
--    route in place. Replanning deletes every vrp_route_step and re-inserts the
--    ordered list rather than renumbering, so without somewhere to put the old
--    plan, history is simply lost.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Eviction counter ──────────────────────────────────────────────────────

ALTER TABLE "public"."packages"
    ADD COLUMN IF NOT EXISTS "eviction_count" integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN "public"."packages"."eviction_count" IS
    'How many times this package has been bumped off a shift to make room for a package with a deadline. At MAX_EVICTIONS (2) it becomes immovable, which is what bounds the eviction rule.';

-- ── 2. warehouse.timezone ────────────────────────────────────────────────────

ALTER TABLE "public"."warehouse"
    ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'UTC';

CREATE OR REPLACE FUNCTION "public"."set_warehouse_timezone"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- SECURITY DEFINER: tzdata.timezone is not readable by PostgREST's
    -- authenticated role, and a dispatcher moving a warehouse pin must not have
    -- to be.
    SECURITY DEFINER
    SET search_path = ''
AS $$
DECLARE
    v_tzid text;
BEGIN
    SELECT tz.tzid
      INTO v_tzid
      FROM tzdata.timezone tz
     WHERE extensions.st_within(
               extensions.st_setsrid(NEW.warehouse_location, 4326),
               tz.geom
           )
     LIMIT 1;

    -- UTC rather than an error: a warehouse in the ocean, or a tzdata table that
    -- has not been imported yet, must not block creating the warehouse.
    NEW.timezone := COALESCE(v_tzid, 'UTC');
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."set_warehouse_timezone"() IS
    'Resolves warehouse.timezone from tzdata.timezone by point-in-polygon whenever warehouse_location is written. Replaces the hourly in-memory cache the nightly scheduler kept.';

DROP TRIGGER IF EXISTS "warehouse_set_timezone" ON "public"."warehouse";

CREATE TRIGGER "warehouse_set_timezone"
    BEFORE INSERT OR UPDATE OF "warehouse_location" ON "public"."warehouse"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."set_warehouse_timezone"();

-- Backfill. Same query as the trigger, run once for existing rows.
UPDATE "public"."warehouse" w
   SET "timezone" = COALESCE(
       (SELECT tz."tzid"
          FROM "tzdata"."timezone" tz
         WHERE "extensions"."st_within"(
                   "extensions"."st_setsrid"(w."warehouse_location", 4326),
                   tz."geom"
               )
         LIMIT 1),
       'UTC'
   );

COMMENT ON COLUMN "public"."warehouse"."timezone" IS
    'IANA timezone, maintained by the warehouse_set_timezone trigger. The service day a package is assigned to is this warehouse''s local date.';

-- ── 3. One row per driver/vehicle pair ───────────────────────────────────────

-- Keep the earliest row per pair: assigned_at is meant to record when the
-- pairing began, and nothing references driver_vehicle_assignment.id.
DELETE FROM "public"."driver_vehicle_assignment" dva
 USING (
     SELECT "id",
            row_number() OVER (
                PARTITION BY "driver_id", "vehicle_id"
                ORDER BY "assigned_at" ASC, "id" ASC
            ) AS rn
       FROM "public"."driver_vehicle_assignment"
 ) dupes
 WHERE dupes."id" = dva."id"
   AND dupes.rn > 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.driver_vehicle_assignment'::regclass
           AND conname  = 'driver_vehicle_assignment_driver_vehicle_key'
    ) THEN
        ALTER TABLE "public"."driver_vehicle_assignment"
            ADD CONSTRAINT "driver_vehicle_assignment_driver_vehicle_key"
            UNIQUE ("driver_id", "vehicle_id");
    END IF;
END;
$$;

-- ── 4. Plan history ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."vrp_optimization_revision" (
    "id" bigserial PRIMARY KEY,
    "optimisation_id" uuid NOT NULL
        REFERENCES "public"."vrp_optimization"("id") ON DELETE CASCADE,
    "revision" integer NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    -- Why the plan changed: 'assign', 'evict', 'replan', 'manual_add',
    -- 'manual_remove', 'dispatch'. Free text rather than an enum so a new
    -- trigger does not need a migration to be recordable.
    "reason" text NOT NULL,
    -- The plan as it stood BEFORE this revision replaced it: the ordered route
    -- steps, plus the solver request/response when one was involved. This is
    -- what vrp_route_step used to carry before replans started rewriting it.
    "steps" jsonb,
    "request" jsonb,
    "response" jsonb
);

CREATE INDEX IF NOT EXISTS "vrp_optimization_revision_opt_idx"
    ON "public"."vrp_optimization_revision" ("optimisation_id", "revision" DESC);

ALTER TABLE "public"."vrp_optimization_revision" ENABLE ROW LEVEL SECURITY;

-- Read-only for org members who can see the shift; nobody writes through
-- PostgREST. The API connects as the Postgres role, which bypasses RLS.
DROP POLICY IF EXISTS "vrp optimization revision select org"
    ON "public"."vrp_optimization_revision";

CREATE POLICY "vrp optimization revision select org"
    ON "public"."vrp_optimization_revision"
    FOR SELECT TO "authenticated"
    USING (
        "public"."has_org_permission"(
            "public"."vrp_optimization_org"("optimisation_id"),
            'shifts.view'::text
        )
    );

COMMENT ON TABLE "public"."vrp_optimization_revision" IS
    'Append-only history of a shift''s plan. Tier 2 replans delete and re-insert vrp_route_step in place, so the superseded ordering lives here instead.';
