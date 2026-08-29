-- Fixes a live billing bug and turns the metering cron into a listener.
--
-- BillingService.reportShiftUsage() runs `SELECT ... WHERE reported_at IS NULL`,
-- posts a Stripe meter event for the batch, then marks the rows reported. There
-- is no claim step between the read and the Stripe call, so two replicas ticking
-- within the same minute both read the same unreported rows and both report
-- them. Every shift is billed once per running replica.
--
-- The fix is a claim column. A reporter UPDATEs reporting_started_at with a
-- RETURNING, which is atomic, then reports only the ids that came back. A claim
-- older than five minutes is considered abandoned -- the reporter crashed
-- between claiming and reporting -- and becomes claimable again, so a crash
-- costs a delayed report rather than a lost one.
--
-- pg_notify replaces the every-minute poll: the outbox trigger already runs
-- inside the shift insert, so it can wake the reporter directly.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "stripe"."shift_usage_events"
    ADD COLUMN IF NOT EXISTS "reporting_started_at" timestamptz;

COMMENT ON COLUMN "stripe"."shift_usage_events"."reporting_started_at" IS
    'When a reporter claimed this row. Claimed-but-unreported rows older than 5 minutes are treated as abandoned and re-claimable, so a reporter that dies mid-report delays a meter event instead of dropping one.';

-- Drives the claim UPDATE. shift_usage_events_unreported_idx already covers
-- (organisation_id, occurred_at) WHERE reported_at IS NULL; this one carries
-- reporting_started_at so the "unclaimed or stale claim" predicate is satisfied
-- from the index rather than by rechecking the heap.
CREATE INDEX IF NOT EXISTS "shift_usage_events_claimable_idx"
    ON "stripe"."shift_usage_events" ("organisation_id", "reporting_started_at")
    WHERE "reported_at" IS NULL;

CREATE OR REPLACE FUNCTION "public"."log_shift_usage_event"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- SECURITY DEFINER: stripe.shift_usage_events has RLS enabled with no
    -- policies, so the inserting role (PostgREST's authenticated role, on the
    -- manual-shift path) could not write to it directly.
    SECURITY DEFINER
    SET search_path = ''
AS $$
BEGIN
    IF NEW.organisation_id IS NOT NULL THEN
        -- Unconditional: this only records that a shift happened. Stripe's
        -- graduated tiers, not this trigger, decide from the *cumulative*
        -- reported usage which shifts were free and which were billable.
        INSERT INTO stripe.shift_usage_events (organisation_id, vrp_optimization_id)
        VALUES (NEW.organisation_id, NEW.id);

        -- Wakes ShiftUsageReporter. Delivered at COMMIT, so a rolled-back shift
        -- insert never wakes anybody. Losing a notification (no listener
        -- connected, or a reconnect in flight) costs nothing: the reporter also
        -- sweeps on its own timer, and the outbox row is durable either way.
        PERFORM pg_notify('hikyaku_shift_usage', NEW.organisation_id::text);
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."log_shift_usage_event"() IS
    'Records every shift into stripe.shift_usage_events and notifies hikyaku_shift_usage so ShiftUsageReporter can batch it to the Stripe Billing Meter. Runs AFTER INSERT on public.vrp_optimization.';
