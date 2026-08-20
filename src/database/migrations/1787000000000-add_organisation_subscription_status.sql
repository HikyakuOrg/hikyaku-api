-- Stripe becomes the source of truth for the trial deadline. This migration adds
-- a cached subscription-status column and rewires set_organisation_trial() to
-- stop computing "+7 days" itself. From here, trial_ends_at and
-- subscription_status are written by application code — BillingService's lazy
-- ensureSubscription() the first time an org's trial status is asked for, and
-- the customer.subscription.* webhook after that — once the real Stripe
-- subscription exists. The trigger's only remaining job is to stop a client
-- from smuggling either value in on INSERT, same as before.
--
-- subscription_status values, and what trialState() (src/common/trial.ts) does
-- with each:
--   NULL              no Stripe subscription yet — a personal org, or a company
--                      org BillingService has not provisioned yet. Unrestricted.
--   'grandfathered'   backfilled below onto every company org that already
--                      existed when this migration ran. Unrestricted,
--                      permanently: these orgs were never told they were on a
--                      metered trial, so enrolling them retroactively (or worse,
--                      treating the sentinel as an unrecognised/blocking status)
--                      would either silently start a trial nobody agreed to, or
--                      lock them out outright. Mirrors the backfill reasoning in
--                      add_organisation_trial.sql, which rejected both for the
--                      same reason.
--   'trialing'        a real Stripe trial is running; trial_ends_at is
--                      authoritative.
--   'active'           paying; unrestricted.
--   'canceled' / 'incomplete_expired' / 'unpaid'
--                      trial (or subscription) is over; blocked.
--   anything else      fails open (unrestricted) — an unrecognised or future
--                      Stripe status must not silently lock an org out.

ALTER TABLE "public"."organisations"
    ADD COLUMN "subscription_status" text;

COMMENT ON COLUMN "public"."organisations"."subscription_status" IS
    'Cached Stripe subscription status, or ''grandfathered'' for a company org '
    'that predates Stripe billing. NULL = not yet provisioned. See trialState() '
    'in src/common/trial.ts for how each value is interpreted.';

-- Grandfather every company org that already exists: preserves current access
-- exactly as-is, and — critically — opts them out of
-- BillingService.ensureSubscription(), which only provisions an org whose
-- subscription_status is still NULL. Without this, the next dashboard load for
-- every existing company org would silently create a live Stripe customer +
-- subscription and start a brand-new 7-day clock, which none of them agreed to.
UPDATE "public"."organisations"
    SET "subscription_status" = 'grandfathered'
    WHERE "org_type" = 'company';

-- Rewire the insert trigger: it no longer computes a deadline itself, only
-- blocks a client-supplied value on both columns (the table-level INSERT grant
-- covers every column, same reasoning as the original migration). A brand-new
-- company org now starts with both columns NULL and is provisioned
-- asynchronously, on its first authenticated request, by
-- BillingService.ensureSubscription().
CREATE OR REPLACE FUNCTION "public"."set_organisation_trial"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    NEW.trial_ends_at := NULL;
    NEW.subscription_status := NULL;
    RETURN NEW;
END;
$$;
