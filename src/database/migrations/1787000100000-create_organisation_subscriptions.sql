-- Satellite table pairing an organisation with its Stripe Billing customer +
-- subscription — the billing equivalent of stripe.organisation_accounts, which
-- pairs an org with its Connect account. Kept separate from public.organisations
-- because these are internal Stripe object ids, not something a tenant ever
-- needs to read directly; organisations.subscription_status/trial_ends_at (see
-- AddSubscriptionStatus) are the public-safe cached projection of this row that
-- the dashboard and PermissionGuard actually read.
--
-- RLS is enabled with no policies, same as organisation_accounts — this locks
-- the table to the Postgres role TypeORM connects as (which bypasses RLS
-- entirely) and out of reach of PostgREST's `authenticated`/`anon` roles.
CREATE TABLE "stripe"."organisation_subscriptions" (
    "organisation_id" uuid PRIMARY KEY
        REFERENCES "public"."organisations"("id") ON DELETE CASCADE,
    "stripe_customer_id" text,
    "stripe_subscription_id" text,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "stripe"."organisation_subscriptions"
    ADD CONSTRAINT "organisation_subscriptions_stripe_subscription_id_key"
    UNIQUE ("stripe_subscription_id");

CREATE INDEX "organisation_subscriptions_stripe_customer_id_idx"
    ON "stripe"."organisation_subscriptions" USING "btree" ("stripe_customer_id");

ALTER TABLE "stripe"."organisation_subscriptions" ENABLE ROW LEVEL SECURITY;
