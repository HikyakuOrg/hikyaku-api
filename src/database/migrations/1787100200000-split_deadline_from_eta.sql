-- Separates the customer promise from the planner's guess.
--
-- package_delivery_window.scheduled_arrival is currently both. Three of its four
-- writers treat it as the deadline -- the booking checkout writes the promised
-- delivery date, the API's package creation writes the requested deadline, and
-- the optimiser deliberately never touches it. The fourth, the web
-- manual-shift action, overwrites it with a computed ETA
-- (hikyaku/lib/actions/shift.ts). Once that happens the deadline is gone: there
-- is nothing left to check feasibility against, and the package silently becomes
-- "due whenever we happened to plan it".
--
-- Instant assignment makes that fatal rather than merely wrong, because the
-- whole eviction rule turns on "does this package have a deadline". So:
--
--   scheduled_arrival  = the promise. Written at creation, never by a planner.
--   estimated_arrival  = planner output. Rewritten on every replan, freely.
--
-- Minimum churn by design: the column that already means "deadline" everywhere
-- but one place keeps meaning that, and the new column absorbs the one writer
-- that was wrong.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "public"."package_delivery_window"
    ADD COLUMN IF NOT EXISTS "estimated_arrival" timestamptz;

-- Backfill: for rows the manual-shift path wrote, scheduled_arrival IS the ETA,
-- and there is no way to tell those apart from genuine deadlines after the fact.
-- Seeding every row's ETA from scheduled_arrival is right for exactly that case
-- and harmless everywhere else -- the next replan overwrites it, and nothing
-- reads estimated_arrival as a constraint.
UPDATE "public"."package_delivery_window"
   SET "estimated_arrival" = "scheduled_arrival"
 WHERE "estimated_arrival" IS NULL
   AND "scheduled_arrival" IS NOT NULL;

COMMENT ON COLUMN "public"."package_delivery_window"."scheduled_arrival" IS
    'Hard deadline -- the promise made to the customer. Written once at creation and never by a planner. NULL means the package has no promise, which is what makes it eligible to be bumped off a shift.';

COMMENT ON COLUMN "public"."package_delivery_window"."estimated_arrival" IS
    'Planner ETA. Rewritten for the whole route on every assignment and every replan. Never a constraint.';
