-- Caches whether an org's Stripe customer has a usable default payment method,
-- the same way organisations.subscription_status/trial_ends_at cache Stripe
-- subscription state (see AddOrganisationSubscriptionStatus). Lives on
-- stripe.organisation_subscriptions rather than public.organisations because,
-- like stripe_customer_id/stripe_subscription_id on that same row, it is an
-- internal billing detail a tenant never reads directly -- it is only consumed by
-- enforce_shift_allowance() (see AddShiftUsageMetering) and BillingService's
-- usage endpoint, both of which already go through this table.
--
-- Defaults to false: a freshly-provisioned customer (see BillingService, personal
-- orgs especially, which get a Stripe customer for the first time here) has no
-- payment method until the customer explicitly adds one via the Billing Portal.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "stripe"."organisation_subscriptions"
    ADD COLUMN IF NOT EXISTS "has_payment_method" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "stripe"."organisation_subscriptions"."has_payment_method" IS
    'Synced from the customer.updated webhook (invoice_settings.default_payment_method). '
    'Read by enforce_shift_allowance() to decide whether an org that has exhausted its '
    'free shift allowance may keep creating shifts (billed as overage) or must be blocked.';
