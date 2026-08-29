-- Turns public.vrp_optimization into a first-class "shift".
--
-- Until now a shift was a bare solver artefact: a provider, a request blob and a
-- response blob. Everything that makes it a shift -- which driver, which van,
-- which depot, which day -- was stuffed into request->'_meta' by the web
-- manual-shift server action (hikyaku/lib/actions/shift.ts) and into
-- request->'meta' by OptimisationService.runAdhoc. Neither is indexable, and
-- neither survives a replan that rewrites `request`.
--
-- Instant assignment needs to answer "which shifts at this warehouse are still
-- open today?" in one indexed query on the request hot path, so those four facts
-- become columns, plus a lifecycle status, a revision counter the clients poll,
-- and the two lifecycle timestamps.
--
-- The two partial unique indexes at the end are the concurrency backstop behind
-- "one open shift per vehicle per day". AssignmentService checks it under a
-- per-warehouse advisory lock, but the lock only covers this API -- the web
-- dashboard still inserts vrp_optimization straight through PostgREST. The index
-- makes the invariant true regardless of who writes.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Columns ───────────────────────────────────────────────────────────────

ALTER TABLE "public"."vrp_optimization"
    ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'planned',
    ADD COLUMN IF NOT EXISTS "driver_id" uuid,
    ADD COLUMN IF NOT EXISTS "vehicle_id" uuid,
    ADD COLUMN IF NOT EXISTS "warehouse_id" uuid,
    ADD COLUMN IF NOT EXISTS "shift_date" date,
    ADD COLUMN IF NOT EXISTS "dispatched_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "completed_at" timestamptz,
    ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

-- NOT VALID then VALIDATE: the ADD takes a brief ACCESS EXCLUSIVE lock without
-- scanning the table, and the scan afterwards runs under SHARE UPDATE EXCLUSIVE.
-- Every existing row already reads 'planned' from the column default, so the
-- validation cannot fail.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_optimization'::regclass
           AND conname  = 'vrp_optimization_status_check'
    ) THEN
        ALTER TABLE "public"."vrp_optimization"
            ADD CONSTRAINT "vrp_optimization_status_check"
            CHECK ("status" IN ('planned', 'dispatched', 'completed', 'cancelled'))
            NOT VALID;
        ALTER TABLE "public"."vrp_optimization"
            VALIDATE CONSTRAINT "vrp_optimization_status_check";
    END IF;
END;
$$;

-- No ON DELETE CASCADE on any of the three: losing a driver, a van or a depot
-- must not silently erase the shift history those rows are billed against.
-- RESTRICT is the existing convention for vehicles (see the soft-delete trigger
-- check_vehicle_soft_deletion_rules) and matches drivers_id_fkey's intent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_optimization'::regclass
           AND conname  = 'vrp_optimization_driver_id_fkey'
    ) THEN
        ALTER TABLE "public"."vrp_optimization"
            ADD CONSTRAINT "vrp_optimization_driver_id_fkey"
            FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id");
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_optimization'::regclass
           AND conname  = 'vrp_optimization_vehicle_id_fkey'
    ) THEN
        ALTER TABLE "public"."vrp_optimization"
            ADD CONSTRAINT "vrp_optimization_vehicle_id_fkey"
            FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id");
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_optimization'::regclass
           AND conname  = 'vrp_optimization_warehouse_id_fkey'
    ) THEN
        ALTER TABLE "public"."vrp_optimization"
            ADD CONSTRAINT "vrp_optimization_warehouse_id_fkey"
            FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id");
    END IF;
END;
$$;

COMMENT ON COLUMN "public"."vrp_optimization"."status" IS
    'Shift lifecycle. Only ''planned'' is open to automatic assignment, and only until 15 minutes before scheduled_start.';
COMMENT ON COLUMN "public"."vrp_optimization"."shift_date" IS
    'Warehouse-local service day. Paired with status by the partial unique indexes that cap a vehicle/driver at one open shift per day.';
COMMENT ON COLUMN "public"."vrp_optimization"."revision" IS
    'Bumped by vrp_optimization_touch on every UPDATE. Clients poll GET /api/v1/shifts/{id}/version and reload only when it moves.';

-- ── 2. Backfill from the two _meta shapes ────────────────────────────────────
--
-- Manual shifts (web) write request->'_meta' with snake_case keys; ad-hoc runs
-- (mobile, OptimisationService.runAdhoc) write request->'meta' with camelCase
-- keys and no explicit date. Anything else -- the nightly and on-demand solves --
-- carries neither, so driver/vehicle come from the package_assignment rows its
-- packages point at, and the warehouse from the packages themselves.

UPDATE "public"."vrp_optimization" v
   SET "driver_id" = COALESCE(
           v."driver_id",
           NULLIF(v."request" -> '_meta' ->> 'driver_id', '')::uuid,
           NULLIF(v."request" -> 'meta'  ->> 'driverId',  '')::uuid,
           (SELECT pa."driver_id"
              FROM "public"."packages" p
              JOIN "public"."package_assignment" pa ON pa."package_id" = p."id"
             WHERE p."optimisation_id" = v."id"
             LIMIT 1)
       ),
       "vehicle_id" = COALESCE(
           v."vehicle_id",
           NULLIF(v."request" -> '_meta' ->> 'vehicle_id', '')::uuid,
           NULLIF(v."request" -> 'meta'  ->> 'vehicleId',  '')::uuid,
           (SELECT pa."vehicle_id"
              FROM "public"."packages" p
              JOIN "public"."package_assignment" pa ON pa."package_id" = p."id"
             WHERE p."optimisation_id" = v."id"
             LIMIT 1)
       ),
       "warehouse_id" = COALESCE(
           v."warehouse_id",
           NULLIF(v."request" -> '_meta' ->> 'warehouse_id',      '')::uuid,
           NULLIF(v."request" -> 'meta'  ->> 'startingLocationId', '')::uuid,
           (SELECT p."warehouse_id"
              FROM "public"."packages" p
             WHERE p."optimisation_id" = v."id"
               AND p."warehouse_id" IS NOT NULL
             LIMIT 1)
       ),
       "shift_date" = COALESCE(
           v."shift_date",
           NULLIF(v."request" -> '_meta' ->> 'shift_date', '')::date,
           (NULLIF(v."request" -> 'meta' ->> 'startDateTime', '')::timestamptz)::date,
           (COALESCE(v."scheduled_start", v."created_at"))::date
       );

-- A driver or vehicle that has since been hard-deleted would fail the FKs added
-- above, so drop the reference rather than the row.
UPDATE "public"."vrp_optimization" v
   SET "driver_id" = NULL
 WHERE v."driver_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "public"."drivers" d WHERE d."id" = v."driver_id");

UPDATE "public"."vrp_optimization" v
   SET "vehicle_id" = NULL
 WHERE v."vehicle_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "public"."vehicles" ve WHERE ve."id" = v."vehicle_id");

UPDATE "public"."vrp_optimization" v
   SET "warehouse_id" = NULL
 WHERE v."warehouse_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "public"."warehouse" w WHERE w."id" = v."warehouse_id");

-- Terminal shifts: every package on the shift is DELIVERED or FAILED. A shift
-- with no packages at all is left 'planned' -- it is genuinely still open, and
-- the shift_date filter on the candidate query keeps historical ones out of
-- today's search anyway.
UPDATE "public"."vrp_optimization" v
   SET "status"       = 'completed',
       "completed_at" = COALESCE(v."completed_at", v."created_at")
 WHERE v."status" = 'planned'
   AND EXISTS (SELECT 1 FROM "public"."packages" p WHERE p."optimisation_id" = v."id")
   AND NOT EXISTS (
       SELECT 1
         FROM "public"."packages" p
         LEFT JOIN LATERAL (
             SELECT ps."enums"
               FROM "public"."package_timeline" pt
               JOIN "public"."package_status" ps ON ps."id" = pt."package_status"
              WHERE pt."package_id" = p."id"
              ORDER BY pt."created_at" DESC, pt."id" DESC
              LIMIT 1
         ) latest ON true
        WHERE p."optimisation_id" = v."id"
          AND COALESCE(latest."enums", 'PENDING') NOT IN ('DELIVERED', 'FAILED')
   );

-- ── 3. Pre-flight the partial unique indexes ─────────────────────────────────
--
-- CREATE UNIQUE INDEX fails outright on the first duplicate it meets, and a
-- migration that dies halfway through a deploy is far worse than one that
-- resolves the historical mess deliberately. Nothing stopped two nightly solves
-- from landing on the same van on the same day before this migration, so resolve
-- the duplicates here: keep the newest open shift per (vehicle, day) and per
-- (driver, day), and close the rest.

WITH ranked AS (
    SELECT v."id",
           row_number() OVER (
               PARTITION BY v."vehicle_id", v."shift_date"
               ORDER BY v."created_at" DESC, v."id" DESC
           ) AS rn
      FROM "public"."vrp_optimization" v
     WHERE v."status" IN ('planned', 'dispatched')
       AND v."vehicle_id" IS NOT NULL
       AND v."shift_date" IS NOT NULL
)
UPDATE "public"."vrp_optimization" v
   SET "status"       = 'completed',
       "completed_at" = COALESCE(v."completed_at", now())
  FROM ranked r
 WHERE r."id" = v."id"
   AND r.rn > 1;

WITH ranked AS (
    SELECT v."id",
           row_number() OVER (
               PARTITION BY v."driver_id", v."shift_date"
               ORDER BY v."created_at" DESC, v."id" DESC
           ) AS rn
      FROM "public"."vrp_optimization" v
     WHERE v."status" IN ('planned', 'dispatched')
       AND v."driver_id" IS NOT NULL
       AND v."shift_date" IS NOT NULL
)
UPDATE "public"."vrp_optimization" v
   SET "status"       = 'completed',
       "completed_at" = COALESCE(v."completed_at", now())
  FROM ranked r
 WHERE r."id" = v."id"
   AND r.rn > 1;

-- ── 4. Indexes ───────────────────────────────────────────────────────────────

-- The Tier 1 candidate query: open shifts at one warehouse on one day.
CREATE INDEX IF NOT EXISTS "vrp_optimization_open_shift_idx"
    ON "public"."vrp_optimization" ("warehouse_id", "shift_date", "status");

-- The invariant. Partial so a completed or cancelled shift stops occupying the
-- slot, which is what lets a van run a second shift after the first is closed.
-- NULL vehicle_id / driver_id rows are excluded rather than colliding, since a
-- b-tree treats NULLs as distinct -- exactly right for the historical nightly
-- rows that never had a van.
CREATE UNIQUE INDEX IF NOT EXISTS "vrp_optimization_open_vehicle_day_idx"
    ON "public"."vrp_optimization" ("vehicle_id", "shift_date")
    WHERE "status" IN ('planned', 'dispatched');

CREATE UNIQUE INDEX IF NOT EXISTS "vrp_optimization_open_driver_day_idx"
    ON "public"."vrp_optimization" ("driver_id", "shift_date")
    WHERE "status" IN ('planned', 'dispatched');

-- ── 5. revision / updated_at ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "public"."vrp_optimization_touch"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    -- Unconditional. Tier 2 rewrites route steps rather than the optimisation
    -- row, and signals "the plan moved" by UPDATEing this row; a conditional
    -- bump would make the poll miss exactly that case.
    NEW.revision   := OLD.revision + 1;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."vrp_optimization_touch"() IS
    'Bumps vrp_optimization.revision and updated_at on every UPDATE. GET /api/v1/shifts/{id}/version reads both.';

DROP TRIGGER IF EXISTS "vrp_optimization_touch" ON "public"."vrp_optimization";

CREATE TRIGGER "vrp_optimization_touch"
    BEFORE UPDATE ON "public"."vrp_optimization"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."vrp_optimization_touch"();

-- ── 6. planned → dispatched, driven by the driver app ────────────────────────
--
-- The driver app writes package_timeline straight through PostgREST; it never
-- calls POST /shifts/{id}/dispatch. So the moment any package on a shift reaches
-- IN_TRANSIT, the van has rolled and the shift must close to further automatic
-- assignment -- silently adding a stop to a driver already navigating is a
-- safety problem, not a UX one.

CREATE OR REPLACE FUNCTION "public"."dispatch_shift_on_in_transit"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- SECURITY DEFINER: the driver's PostgREST role can insert package_timeline
    -- but has no UPDATE grant on vrp_optimization.
    SECURITY DEFINER
    SET search_path = ''
AS $$
DECLARE
    v_opt_id uuid;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.package_status ps
         WHERE ps.id = NEW.package_status AND ps.enums = 'IN_TRANSIT'
    ) THEN
        RETURN NEW;
    END IF;

    SELECT p.optimisation_id INTO v_opt_id
      FROM public.packages p
     WHERE p.id = NEW.package_id;

    IF v_opt_id IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE public.vrp_optimization
       SET status        = 'dispatched',
           dispatched_at = COALESCE(dispatched_at, now())
     WHERE id = v_opt_id
       AND status = 'planned';

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."dispatch_shift_on_in_transit"() IS
    'Closes a shift to automatic assignment as soon as the driver marks any of its packages IN_TRANSIT. The driver app writes package_timeline directly, so this cannot live in the API.';

DROP TRIGGER IF EXISTS "package_timeline_dispatch_shift" ON "public"."package_timeline";

CREATE TRIGGER "package_timeline_dispatch_shift"
    AFTER INSERT ON "public"."package_timeline"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."dispatch_shift_on_in_transit"();
