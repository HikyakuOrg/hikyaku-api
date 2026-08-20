-- Enforces a per-billing-period free shift allowance and logs every shift for
-- async reporting to a Stripe Billing Meter, covering all three places a "shift"
-- (a public.vrp_optimization row) gets created:
--   1. The manual-shift Next.js server action (hikyaku/lib/actions/shift.ts),
--      which inserts straight through PostgREST -- no NestJS involved.
--   2. OptimisationService.runAdhoc (mobile), via DatabaseService.insertAdhocRoutes.
--   3. TasksService's pgmq consumer (on-demand + nightly), via
--      DatabaseService.insertOptimisedRoutes.
--
-- Only a trigger on the table itself sees all three paths, since (1) never touches
-- hikyaku-api. This mirrors enforce_personal_org_warehouse_limit() in
-- LimitPersonalOrgWarehouses -- same SECURITY DEFINER + row-lock-then-count shape,
-- same 23514 check_violation so PostgREST/callers get a readable message. See that
-- migration's comment for why a trigger, not a constraint or index, is used here.
--
-- Unlike the warehouse limit, exceeding the allowance does not always block: it
-- blocks only when the org also has no payment method on file (has_payment_method,
-- see AddOrganisationPaymentMethodStatus). With a payment method, Stripe simply
-- invoices the overage via the org's metered subscription item -- the block exists
-- only to stop free usage from running up an unpayable bill.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- Outbox table: the enforcement trigger runs synchronously inside every shift
-- insert and cannot itself call the Stripe API, so it only records that a shift
-- happened. BillingService.reportShiftUsage() polls the unreported rows on a
-- cron, batches them per organisation, and reports one meter event per org per
-- tick. RLS enabled with no policies -- same lockdown as
-- stripe.organisation_subscriptions: reachable only by the Postgres role TypeORM
-- connects as (which bypasses RLS), not by PostgREST's authenticated/anon roles.
CREATE TABLE "stripe"."shift_usage_events" (
    "id" bigserial PRIMARY KEY,
    "organisation_id" uuid NOT NULL REFERENCES "public"."organisations"("id") ON DELETE CASCADE,
    "vrp_optimization_id" uuid NOT NULL REFERENCES "public"."vrp_optimization"("id") ON DELETE CASCADE,
    "occurred_at" timestamptz NOT NULL DEFAULT now(),
    "reported_at" timestamptz
);

ALTER TABLE "stripe"."shift_usage_events" ENABLE ROW LEVEL SECURITY;

-- Drives reportShiftUsage()'s "unreported rows, oldest first" poll.
CREATE INDEX "shift_usage_events_unreported_idx"
    ON "stripe"."shift_usage_events" ("organisation_id", "occurred_at")
    WHERE "reported_at" IS NULL;


CREATE OR REPLACE FUNCTION "public"."enforce_shift_allowance"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- SECURITY DEFINER for the same two reasons as enforce_personal_org_warehouse_limit:
    -- it reads public.organisations and stripe.organisation_subscriptions, which the
    -- caller (PostgREST's authenticated role, for the manual-shift path) cannot
    -- necessarily SELECT under RLS, and it must count EVERY shift in the org this
    -- period, not just the rows the caller can see.
    SECURITY DEFINER
    SET search_path = ''
AS $$
DECLARE
    -- PLACEHOLDER allowances -- keep in step with $PersonalShiftsFree /
    -- $OrganisationShiftsFree in create-stripe-subscriptions.ps1 (that script owns
    -- the actual Stripe pricing; these are the enforcement-side mirror of the same
    -- numbers). Retuning either requires a new migration, same as the warehouse
    -- trigger's v_limit.
    v_personal_free  constant integer := 30;
    v_company_free   constant integer := 600;
    v_org_type       text;
    v_free           integer;
    v_used           bigint;
    v_has_payment    boolean;
BEGIN
    IF NEW.organisation_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Lock the org row for the rest of the transaction -- same race-safety
    -- reasoning as the warehouse trigger: without it, two concurrent shift
    -- inserts for an org sitting exactly at its allowance both count the same
    -- "still under" total and both commit.
    SELECT o.org_type
      INTO v_org_type
      FROM public.organisations o
     WHERE o.id = NEW.organisation_id
       FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        -- No such org. The vrp_optimization organisation_id FK rejects this row a
        -- moment later with a better message than anything this function could raise.
        RETURN NEW;
    END IF;

    v_free := CASE WHEN v_org_type = 'personal' THEN v_personal_free ELSE v_company_free END;

    SELECT count(*)
      INTO v_used
      FROM public.vrp_optimization v
     WHERE v.organisation_id = NEW.organisation_id
       AND v.created_at >= date_trunc('month', now())
       AND v.id IS DISTINCT FROM NEW.id;

    IF v_used < v_free THEN
        RETURN NEW;
    END IF;

    SELECT s.has_payment_method
      INTO v_has_payment
      FROM stripe.organisation_subscriptions s
     WHERE s.organisation_id = NEW.organisation_id;

    IF COALESCE(v_has_payment, false) THEN
        -- Over the free allowance but billable -- let it through, the overage is
        -- picked up by reportShiftUsage()/the org's metered subscription item.
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'You have used your % free shifts this billing period. Add a payment method to keep creating shifts.',
        v_free
        USING ERRCODE = 'check_violation',
              DETAIL  = format('Organisation %s has created %s shift(s) this period against a free allowance of %s.',
                               NEW.organisation_id, v_used, v_free),
              HINT    = 'Add a payment method from Billing settings to enable pay-as-you-go overage.';
END;
$$;

COMMENT ON FUNCTION "public"."enforce_shift_allowance"() IS
    'Caps shift creation at the org''s free monthly allowance unless a payment method '
    'is on file, in which case usage past the allowance is billed as Stripe metered '
    'overage instead of being blocked. Runs BEFORE INSERT on public.vrp_optimization; '
    'raises 23514 (check_violation) when blocked.';

DROP TRIGGER IF EXISTS "vrp_optimization_shift_allowance" ON "public"."vrp_optimization";

CREATE TRIGGER "vrp_optimization_shift_allowance"
    BEFORE INSERT ON "public"."vrp_optimization"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_shift_allowance"();


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
        -- graduated tiers, not this trigger, decide from the *cumulative* reported
        -- usage which shifts were free and which were billable.
        INSERT INTO stripe.shift_usage_events (organisation_id, vrp_optimization_id)
        VALUES (NEW.organisation_id, NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."log_shift_usage_event"() IS
    'Records every shift into stripe.shift_usage_events for BillingService.reportShiftUsage() '
    'to batch-report to the Stripe Billing Meter. Runs AFTER INSERT on public.vrp_optimization.';

DROP TRIGGER IF EXISTS "vrp_optimization_shift_usage_log" ON "public"."vrp_optimization";

CREATE TRIGGER "vrp_optimization_shift_usage_log"
    AFTER INSERT ON "public"."vrp_optimization"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."log_shift_usage_event"();
