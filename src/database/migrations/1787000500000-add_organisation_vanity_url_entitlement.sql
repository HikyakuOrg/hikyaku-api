-- Caches whether an org's Stripe customer currently holds the `vanity_url`
-- Entitlement Feature (see create-stripe-subscriptions.ps1's
-- $OrganisationFeatures), the same way has_payment_method
-- (AddOrganisationPaymentMethodStatus) caches a different Stripe-derived
-- boolean on this same satellite row. Lives here rather than on
-- public.organisations for the same reason has_payment_method does: it is an
-- internal billing detail, only ever read by
-- get_booking_organisation()/get_tracking_details() (see
-- ResolveOrganisationsByVanitySlug) to decide whether a vanity host should
-- resolve, and by BillingService for the settings-page status endpoint.
--
-- Defaults to false: a freshly-provisioned customer has no entitlement until
-- BillingService looks it up (eagerly, right after provisioning) or the
-- entitlements.active_entitlement_summary.updated webhook confirms one.
-- A grandfathered company org (subscription_status = 'grandfathered' on
-- public.organisations) never gets a Stripe customer at all and so never
-- gets a row here -- it is treated as entitled unconditionally by the
-- readers above, independent of this column.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "stripe"."organisation_subscriptions"
    ADD COLUMN IF NOT EXISTS "has_vanity_url_entitlement" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "stripe"."organisation_subscriptions"."has_vanity_url_entitlement" IS
    'Synced from the entitlements.active_entitlement_summary.updated webhook '
    '(and eagerly once at subscription provisioning). Read by '
    'get_booking_organisation()/get_tracking_details() to decide whether a '
    'company org''s vanity_slug host currently resolves.';
