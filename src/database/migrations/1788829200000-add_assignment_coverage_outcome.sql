--
-- Context: instant assignment now prefers a driver whose service area covers
-- the delivery point, and falls back through four further steps when it cannot
-- have one (see the class comment on src/dispatch/assignment.service.ts). Which
-- of those five steps a package actually took is, today, a debug log line and
-- nothing else.
--
-- That is not good enough to roll the feature out on, for one reason: EVERY
-- INPUT TO A COVERAGE DECISION IS READ FRESH ON EVERY ASSIGNMENT. The
-- territories, the staffing, the idle drivers and the shifts in play are all
-- looked up at decision time and none of them is versioned. The moment a
-- dispatcher redraws an area or moves a driver onto it, the reason a package
-- went where it went yesterday becomes unrecoverable: re-running the coverage
-- query answers today's question, not the one that was asked. So the answer has
-- to be written down when it is taken.
--
-- What ships here:
--   1. package_assignment.coverage_outcome, nullable text.
--   2. a named CHECK restricting it to the five values the engine can produce.
--   3. a partial index for the org-level summary read.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY package_assignment AND NOT vrp_optimization_revision
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The other candidate was the revision snapshot, which already records why a
-- plan changed. It is the wrong grain. A revision is one shift's whole route at
-- a moment in time, and it is written on every replan, every manual add and
-- every manual remove; a coverage outcome belongs to ONE package and is decided
-- exactly once, when that package is first placed. Hanging it off the revision
-- would mean either re-deriving "which package did this revision add" from two
-- adjacent snapshots, or writing the same outcome again on every later rewrite
-- of a route the package happens to still be on.
--
-- package_assignment is the per-package row, it is created by exactly the write
-- that places the package (ShiftPlanWriter.writePlan), and it is deleted by
-- exactly the write that takes it off a shift (ShiftPlanWriter.detach). That
-- lifecycle is the one the outcome wants: a package that is bumped and placed
-- again gets a fresh row and a fresh, correct outcome rather than a stale one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NULLABLE, AND WHAT NULL MEANS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- NULL means "not placed by automatic assignment". Three writers touch this
-- table and only one of them is making a coverage decision:
--
--   - AssignmentService, through commitPlacement, sets a value. Always.
--   - ReplanWorker rewrites a route it did not choose the packages for.
--   - assignToShift and removeFromShift rewrite a route a human edited.
--
-- The last two go through the same writePlan and would otherwise have to
-- invent a value. They pass none, and the upsert coalesces, so a replan or a
-- hand edit preserves whatever the original placement recorded instead of
-- overwriting it with a guess. `WHERE coverage_outcome IS NOT NULL` is
-- therefore exactly the automatically-assigned population, which is the
-- denominator the rollout summary needs.
--
-- Backfilling the existing rows is deliberately NOT attempted. There is no
-- honest value for them: they were placed before coverage existed, and writing
-- `disabled` over them would claim the flag was off during a period when the
-- flag did not exist. They stay NULL and fall out of the summary, which is the
-- truthful answer.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. The column ────────────────────────────────────────────────────────────
--
-- text rather than a Postgres enum. The set of outcomes is expected to move
-- while this is being tuned (splitting "no covering driver" further by whether
-- the territory was undrawn or merely unstaffed is an obvious next step), and
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that then
-- reads the new value, which is a sharp edge to hand a future migration for no
-- storage saving worth having.
--
-- Adding a nullable column with no default does not rewrite the table, so this
-- is a catalogue-only change however many assignments already exist.

ALTER TABLE "public"."package_assignment"
    ADD COLUMN IF NOT EXISTS "coverage_outcome" text;

COMMENT ON COLUMN "public"."package_assignment"."coverage_outcome" IS
    'How the driver that got this package related to who covers its delivery point, recorded at placement time because none of the inputs to that decision are versioned. NULL means the row was not written by automatic assignment (a replan or a dispatcher''s hand edit), so `WHERE coverage_outcome IS NOT NULL` is the automatically-assigned population. `covered`: a territory the driver is staffed on contains the point. `floater`: the driver matched only because they have no territories at all, which is most matches while the map is half drawn and is why it is not merged into `covered`. `fallback_no_covering_capacity`: somebody covers the point but none of them had room or an idle van. `fallback_no_covering_driver`: nobody covers it at all. `disabled`: SERVICE_AREA_MATCHING was off and no coverage question was asked. See src/dispatch/coverage.ts.';

-- ── 2. The value guard ───────────────────────────────────────────────────────
--
-- NOT VALID then VALIDATE, the house pattern from
-- FixServiceAreaSchema1788656400000. ADD CONSTRAINT ... NOT VALID takes a brief
-- ACCESS EXCLUSIVE lock and skips the table scan; VALIDATE CONSTRAINT then
-- scans under a SHARE UPDATE EXCLUSIVE lock that does not block reads or
-- writes. Every existing row is NULL, so the scan finds nothing, but the
-- pattern is kept because the cost of following it is zero and the cost of a
-- full-table ACCESS EXCLUSIVE scan on a table that grows one row per delivered
-- package is not.
--
-- The list must stay in step with COVERAGE_OUTCOMES in src/dispatch/coverage.ts.
-- That constant is declared `satisfies readonly CoverageOutcome[]`, so a value
-- added to the TypeScript union without being added there fails the build; this
-- constraint is the other half, and it fails the insert.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.package_assignment'::regclass
           AND conname  = 'package_assignment_coverage_outcome_chk'
    ) THEN
        ALTER TABLE "public"."package_assignment"
            ADD CONSTRAINT "package_assignment_coverage_outcome_chk"
            CHECK ("coverage_outcome" IS NULL
                   OR "coverage_outcome" IN (
                        'covered',
                        'floater',
                        'fallback_no_covering_capacity',
                        'fallback_no_covering_driver',
                        'disabled'))
            NOT VALID;

        ALTER TABLE "public"."package_assignment"
            VALIDATE CONSTRAINT "package_assignment_coverage_outcome_chk";
    END IF;
END;
$$;

COMMENT ON CONSTRAINT "package_assignment_coverage_outcome_chk" ON "public"."package_assignment" IS
    'The five values src/dispatch/coverage.ts can produce, plus NULL for a row automatic assignment did not write. Kept in step with COVERAGE_OUTCOMES there.';

-- ── 3. The summary index ─────────────────────────────────────────────────────
--
-- The org-level rollout summary asks one question: over the last N days, how
-- did the automatically-assigned packages split across the five outcomes? It
-- filters this table by created_at and by coverage_outcome IS NOT NULL, then
-- joins to packages for the organisation.
--
-- Partial on IS NOT NULL because rows written by a replan or a hand edit are
-- never in the answer, and excluding them keeps the index proportional to the
-- automatically-assigned traffic rather than to every package ever delivered.
-- coverage_outcome is carried as a second column so the grouping can be
-- answered from the index for the rows it selects, without a heap fetch per row
-- just to read a short string.
--
-- NOTE FOR REVIEW: written without a database. Confirm on the first real run
-- that the summary's plan uses this rather than a sequential scan on
-- package_assignment, and be prepared for the planner to legitimately prefer a
-- scan while the table is small, which is not a problem.

CREATE INDEX IF NOT EXISTS "package_assignment_coverage_outcome_idx"
    ON "public"."package_assignment" ("created_at" DESC, "coverage_outcome")
    WHERE "coverage_outcome" IS NOT NULL;
