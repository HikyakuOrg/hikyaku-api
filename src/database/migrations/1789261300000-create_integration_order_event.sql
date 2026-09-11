-- Record-only ledger for inbound external order events (HIK-99: generic
-- ecommerce connector). Every storefront webhook that reaches
-- POST /api/v1/integrations/orders is durably stored here first, keyed by
-- (organisation_id, platform, idempotency_key) so a retried webhook — Shopify
-- retries aggressively on anything but a 2xx/409 — resolves to the same row
-- instead of a duplicate.
--
-- Phase 1 is intentionally record-only: there is no customer_id column yet.
-- customer.customer_location is NOT NULL and there is no automatic geocoder
-- today, so turning a recorded event into a customer/package is separate
-- follow-up work (see HIK-99's description). This table only has to prove an
-- event was received, exactly once per idempotency key.

CREATE TABLE IF NOT EXISTS "public"."integration_order_event" (
    "id"               "uuid"      DEFAULT "gen_random_uuid"() NOT NULL,
    "organisation_id"  "uuid"      NOT NULL,
    "platform"         "text"      NOT NULL,
    "event_type"       "text"      NOT NULL,
    "idempotency_key"  "text"      NOT NULL,
    "external_order_id" "text"     NOT NULL,
    "payload"          "jsonb"     NOT NULL,
    "created_at"       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "integration_order_event_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "integration_order_event_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE
);

ALTER TABLE "public"."integration_order_event" OWNER TO "postgres";

COMMENT ON TABLE "public"."integration_order_event" IS
    'Durable, idempotent ledger of inbound order events from external storefronts (Shopify today; WooCommerce/Magento/MedusaJS later). Record-only for phase 1 -- no link to a customer or package yet. See src/integrations/.';

COMMENT ON COLUMN "public"."integration_order_event"."platform" IS
    'Lowercase connector slug (e.g. "shopify"), supplied by the caller. An open data value, never a closed set encoded anywhere in this schema or in hikyaku-api -- a new connector needs no migration.';

-- The idempotency boundary IntegrationsService checks before every insert:
-- same key within the same org+platform replays the existing row, a
-- different order id under the same key is a 409.
CREATE UNIQUE INDEX "integration_order_event_org_platform_key_idx"
    ON "public"."integration_order_event" ("organisation_id", "platform", "idempotency_key");

-- RLS enabled with no policies -- reachable only by the role hikyaku-api's
-- TypeORM connection uses (service_role, which bypasses RLS), matching
-- stripe.shift_usage_events' posture (see AddShiftUsageMetering). Explicitly
-- revoked from anon/authenticated rather than left to their public-schema
-- default grants: nothing reaches this table through PostgREST, ever -- it is
-- pure ingestion-side bookkeeping, not something the dashboard reads.
ALTER TABLE "public"."integration_order_event" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."integration_order_event" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."integration_order_event" TO "service_role";
