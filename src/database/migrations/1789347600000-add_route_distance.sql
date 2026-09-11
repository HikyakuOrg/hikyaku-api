-- HIK-81: prerequisite for the distance limit in HIK-36. vrp_route and
-- vrp_route_step have no distance column at all today, so nothing in the
-- system — not the planner, not the dashboard, not a dispatcher — knows how
-- far a planned shift actually goes. Both dispatch tiers already compute a
-- distance figure and throw it away: Tier 1 (src/dispatch/insertion.ts) has
-- the haversine-times-DETOUR_FACTOR estimate, Tier 2 gets VROOM's real road
-- distance. This just gives both a place to land.
--
-- What ships here:
--   1. vrp_route_step.distance_m — metres of the leg ARRIVING at that step,
--      not a running total and not the leg leaving it.
--   2. vrp_route.distance_m — the route total, including the return leg to
--      the depot, which no job step owns.
--   3. vrp_route.distance_source — 'estimated' (Tier 1's haversine guess) or
--      'measured' (Tier 2's VROOM road distance). A dispatcher comparing a
--      figure against a driving limit needs to know which kind of number they
--      are reading: an estimate Tier 2 will revise within seconds reads very
--      differently from a confirmed measurement.
--
-- All three nullable, and stay null for every row written before this
-- migration — there is no honest backfill for a plan nobody measured. See
-- ShiftPlanWriter (src/dispatch/shift-plan.writer.ts) for the write side: it
-- writes null rather than zero the moment any one leg is unknown, which is
-- the direction this table has to fail in too.
--
-- OUT OF SCOPE, DELIBERATELY: the dashboard's "re-optimise whole warehouse"
-- button (DatabaseService.insertOptimisedRoutes / insertAdhocRoutes, driven
-- from ReplanWorker.handleOnDemand) writes vrp_route_step directly and does
-- not go through ShiftPlanWriter. It is a separate, older bulk-solve feature
-- from the continuous Tier 1 / Tier 2 loop this epic gates, and this ticket
-- does not touch it. A shift opened that way reads null distance until its
-- first replan through ShiftPlanWriter gives it one.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. vrp_route_step.distance_m ─────────────────────────────────────────────
--
-- Adding a nullable column with no default does not rewrite the table, so
-- this is a catalogue-only change regardless of how many steps already exist.
-- The `>= 0` check is NOT VALID then VALIDATE, the house pattern from
-- AddAssignmentCoverageOutcome1788829200000: every existing row is NULL, so
-- the validation scan finds nothing, but the pattern is kept because it is
-- free and the table grows with every plan written.

ALTER TABLE "public"."vrp_route_step"
    ADD COLUMN IF NOT EXISTS "distance_m" integer;

COMMENT ON COLUMN "public"."vrp_route_step"."distance_m" IS
    'Metres of the leg ARRIVING at this step (not a running total, not the leg leaving it). NULL for a step written before this migration, or when the writer genuinely had no distance for this leg — never coerced to zero. See ShiftPlanWriter.insertSteps.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_route_step'::regclass
           AND conname  = 'vrp_route_step_distance_m_chk'
    ) THEN
        ALTER TABLE "public"."vrp_route_step"
            ADD CONSTRAINT "vrp_route_step_distance_m_chk"
            CHECK ("distance_m" IS NULL OR "distance_m" >= 0)
            NOT VALID;
        ALTER TABLE "public"."vrp_route_step"
            VALIDATE CONSTRAINT "vrp_route_step_distance_m_chk";
    END IF;
END;
$$;

-- ── 2 & 3. vrp_route.distance_m and distance_source ──────────────────────────
--
-- distance_source is deliberately NOT a column on vrp_route_step: one write
-- always produces every step on a route from the same tier, so a per-route
-- marker says everything a per-step one would, at a tenth of the storage.
--
-- distance_source has no CHECK tying it to whether distance_m is null,
-- because that invariant lives in application code (ShiftPlanWriter always
-- writes both together or neither) and a database constraint enforcing it
-- would have to be re-litigated the moment a third source is ever added.

ALTER TABLE "public"."vrp_route"
    ADD COLUMN IF NOT EXISTS "distance_m" integer,
    ADD COLUMN IF NOT EXISTS "distance_source" text;

COMMENT ON COLUMN "public"."vrp_route"."distance_m" IS
    'Total route distance in metres, including the return leg to the depot that no job step owns. Stored rather than derived by the dashboard from the steps, matching how duration already sits here. NULL before this migration, or whenever any one leg was unknown at write time.';

COMMENT ON COLUMN "public"."vrp_route"."distance_source" IS
    'Which tier last wrote distance_m: ''estimated'' (Tier 1 haversine) or ''measured'' (Tier 2 VROOM). NULL exactly when distance_m is NULL — there is nothing to attribute a source to.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_route'::regclass
           AND conname  = 'vrp_route_distance_m_chk'
    ) THEN
        ALTER TABLE "public"."vrp_route"
            ADD CONSTRAINT "vrp_route_distance_m_chk"
            CHECK ("distance_m" IS NULL OR "distance_m" >= 0)
            NOT VALID;
        ALTER TABLE "public"."vrp_route"
            VALIDATE CONSTRAINT "vrp_route_distance_m_chk";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vrp_route'::regclass
           AND conname  = 'vrp_route_distance_source_chk'
    ) THEN
        ALTER TABLE "public"."vrp_route"
            ADD CONSTRAINT "vrp_route_distance_source_chk"
            CHECK ("distance_source" IS NULL OR "distance_source" IN ('estimated', 'measured'))
            NOT VALID;
        ALTER TABLE "public"."vrp_route"
            VALIDATE CONSTRAINT "vrp_route_distance_source_chk";
    END IF;
END;
$$;
