-- One storefront order can now become several packages. A store that fulfils
-- from more than one location sends fulfillment_groups on its order events,
-- and each group becomes its own package, dispatched from the warehouse its
-- location is mapped to in integration_location_mapping. See
-- src/integrations/order-event.processor.ts.
--
-- What ships here:
--   1. packages.external_fulfillment_id, the storefront group a package was
--      made for.
--   2. packages_org_external_order_key, which allowed one package per order,
--      replaced by packages_org_external_fulfillment_key, which allows one
--      package per order and group.
--   3. integration_order_event_package, linking an event to every package it
--      produced, backfilled from integration_order_event.package_id.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. packages.external_fulfillment_id ─────────────────────────────────────
--
-- NULL for a package made from a whole order (a store with one location, or a
-- connector that sends no groups), and for every package created by hand or
-- by a booking. A group only exists inside an order, hence the CHECK.

ALTER TABLE "public"."packages"
    ADD COLUMN IF NOT EXISTS "external_fulfillment_id" "text";

ALTER TABLE "public"."packages"
    DROP CONSTRAINT IF EXISTS "packages_external_fulfillment_check";
ALTER TABLE "public"."packages"
    ADD CONSTRAINT "packages_external_fulfillment_check" CHECK (
        "external_fulfillment_id" IS NULL OR "external_order_id" IS NOT NULL
    );

COMMENT ON COLUMN "public"."packages"."external_fulfillment_id" IS
    'The storefront''s id for the fulfillment group this package was made for (Shopify: its FulfillmentOrder global id). NULL when the package covers the whole order.';

COMMENT ON COLUMN "public"."packages"."external_order_id" IS
    'The order''s id in the storefront (Shopify: its GraphQL global id). Unique per organisation, platform and external_fulfillment_id.';

-- ── 2. One package per order and group ──────────────────────────────────────
--
-- COALESCE folds a whole-order package (NULL group) into the same key space,
-- so an order still gets at most one whole-order package, and at most one per
-- group. That is what keeps a webhook delivered twice, under the same or a
-- different Idempotency-Key, from putting the same parcel on a van twice.
--
-- Every existing package has a NULL group, and the old index already held
-- them unique per order, so building this one cannot fail on existing rows.
-- It is built before the old one is dropped, so no moment in this migration
-- goes without a guarantee. Its leading columns also serve the processor's
-- "every package of this order" lookup.

CREATE UNIQUE INDEX IF NOT EXISTS "packages_org_external_fulfillment_key"
    ON "public"."packages" (
        "organisation_id",
        "external_platform",
        "external_order_id",
        COALESCE("external_fulfillment_id", '')
    )
    WHERE "external_order_id" IS NOT NULL;

DROP INDEX IF EXISTS "public"."packages_org_external_order_key";

-- ── 3. integration_order_event_package ──────────────────────────────────────
--
-- A link table rather than a package_ids uuid[] on the event: each link has
-- real foreign keys (a deleted package drops out of the list instead of
-- leaving a dangling id), a package can be traced back to its event through
-- an index, and a later change to one group (moved to another location,
-- cancelled) touches one row rather than rewriting an array.
--
-- The link is written on the same transaction as the package, so a package
-- made from an event is never without its link, even if the worker dies
-- before it writes the event's final status.
--
-- CASCADE on the package: deleting a package a dispatcher no longer wants
-- removes it from the list, while the event row itself, the evidence that the
-- order was received, stays.
--
-- external_fulfillment_id repeats the package's own, so the groups of an
-- event can be matched to their links without a join to packages.

CREATE TABLE IF NOT EXISTS "public"."integration_order_event_package" (
    "event_id"                uuid        NOT NULL,
    "package_id"              uuid        NOT NULL,
    "external_fulfillment_id" text,
    "created_at"              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "integration_order_event_package_pkey"
        PRIMARY KEY ("event_id", "package_id"),

    CONSTRAINT "integration_order_event_package_event_id_fkey"
        FOREIGN KEY ("event_id")
        REFERENCES "public"."integration_order_event" ("id")
        ON DELETE CASCADE,

    CONSTRAINT "integration_order_event_package_package_id_fkey"
        FOREIGN KEY ("package_id")
        REFERENCES "public"."packages" ("id")
        ON DELETE CASCADE
);

ALTER TABLE "public"."integration_order_event_package" OWNER TO "postgres";

-- The package foreign key's own lookups, and package -> event.
CREATE INDEX IF NOT EXISTS "integration_order_event_package_package_id_idx"
    ON "public"."integration_order_event_package" ("package_id");

COMMENT ON TABLE "public"."integration_order_event_package" IS
    'Every package an integration_order_event produced or was matched to: one for a whole order, one per fulfillment group for a store that ships from several locations. Written by src/integrations/order-event.processor.ts.';

COMMENT ON COLUMN "public"."integration_order_event_package"."external_fulfillment_id" IS
    'The fulfillment group the package was made for, as on packages.external_fulfillment_id. NULL for a whole-order package.';

-- Events processed before this migration linked their one package through
-- integration_order_event.package_id.
INSERT INTO "public"."integration_order_event_package"
    ("event_id", "package_id", "external_fulfillment_id", "created_at")
SELECT "id", "package_id", NULL, COALESCE("processed_at", "created_at")
  FROM "public"."integration_order_event"
 WHERE "package_id" IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN "public"."integration_order_event"."package_id" IS
    'The first package this event produced. integration_order_event_package lists all of them; this column stays for readers written before an order could produce more than one.';

COMMENT ON COLUMN "public"."integration_order_event"."status" IS
    'Processing state. pending: waiting for the worker (again, after a transient failure, once next_attempt_at passes). processing: claimed by a worker at claimed_at. processed: integration_order_event_package and customer_id say what it produced. skipped: nothing to deliver (digital or pickup-only order, every group picked up or from a location Hikyaku does not deliver for, or an event type that creates nothing); error says why. needs_attention: cannot be fully processed without a human (ungeocodable address, no warehouse, a fulfillment location not mapped to a warehouse); error says why, the groups that could be processed already have their packages, and POST /api/v1/integrations/orders/:id/retry re-queues the rest. failed: transient failures exhausted the retry budget.';

-- RLS enabled with no policies, and revoked from anon and authenticated, like
-- integration_order_event: only hikyaku-api (service_role) reads or writes it.

ALTER TABLE "public"."integration_order_event_package" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."integration_order_event_package" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."integration_order_event_package" TO "service_role";
