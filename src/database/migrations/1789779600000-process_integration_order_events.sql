-- Turns integration_order_event into a work queue. A worker processes each
-- recorded event into a customer and package, and assigns the package to a
-- shift. See src/integrations/order-event.worker.ts.
--
-- The webhook endpoint only records, because Shopify allows 5 s per round
-- trip and one Photon lookup can take longer. The worker claims rows with
-- FOR UPDATE SKIP LOCKED, so replicas never process a row twice.

-- ── Ledger: processing state ─────────────────────────────────────────────────

-- Existing rows default to 'pending' and are processed too.
ALTER TABLE "public"."integration_order_event"
    ADD COLUMN "status"          "text"      NOT NULL DEFAULT 'pending',
    ADD COLUMN "attempts"        integer     NOT NULL DEFAULT 0,
    ADD COLUMN "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN "claimed_at"      timestamptz,
    ADD COLUMN "processed_at"    timestamptz,
    ADD COLUMN "customer_id"     "uuid",
    ADD COLUMN "package_id"      "uuid",
    ADD COLUMN "error"           "text",
    ADD CONSTRAINT "integration_order_event_status_check" CHECK (
        "status" IN ('pending', 'processing', 'processed', 'skipped', 'needs_attention', 'failed')
    ),
    -- SET NULL, not CASCADE: deleting a package keeps the record of the order.
    ADD CONSTRAINT "integration_order_event_customer_id_fkey"
        FOREIGN KEY ("customer_id") REFERENCES "public"."customer" ("id") ON DELETE SET NULL,
    ADD CONSTRAINT "integration_order_event_package_id_fkey"
        FOREIGN KEY ("package_id") REFERENCES "public"."packages" ("id") ON DELETE SET NULL;

COMMENT ON COLUMN "public"."integration_order_event"."status" IS
    'Processing state. pending: waiting for the worker (again, after a transient failure, once next_attempt_at passes). processing: claimed by a worker at claimed_at. processed: package_id/customer_id say what it produced. skipped: nothing to deliver (digital or pickup-only order, or an event type that creates nothing); error says why. needs_attention: cannot be processed without a human (ungeocodable address, no warehouse); error says why, and POST /api/v1/integrations/orders/:id/retry re-queues it. failed: transient failures exhausted the retry budget.';

COMMENT ON COLUMN "public"."integration_order_event"."next_attempt_at" IS
    'Earliest time the worker may claim this row. Pushed forward with backoff after a transient failure (geocoder down, database error).';

COMMENT ON TABLE "public"."integration_order_event" IS
    'Durable, idempotent ledger of inbound order events from external storefronts (Shopify today; WooCommerce/Magento/MedusaJS later), and the work queue that turns each into a customer + package. See src/integrations/.';

-- The worker's claim query: due pending rows and stale processing rows.
CREATE INDEX "integration_order_event_work_idx"
    ON "public"."integration_order_event" ("next_attempt_at")
    WHERE "status" IN ('pending', 'processing');

-- The dashboard's "orders that need a human" list.
CREATE INDEX "integration_order_event_org_status_idx"
    ON "public"."integration_order_event" ("organisation_id", "status", "created_at" DESC);

-- ── Wake-up ──────────────────────────────────────────────────────────────────

-- NOTIFY only wakes the worker. The worker also sweeps on a timer, so a
-- missed NOTIFY adds latency but loses no order. The UPDATE trigger wakes it
-- for rows set back to pending (by hand or by the retry endpoint). Postgres
-- sends NOTIFY at COMMIT, so the row is visible when the worker wakes.
CREATE OR REPLACE FUNCTION "public"."integration_order_event_notify"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM pg_notify('hikyaku_order_event', NEW.id::text);
    RETURN NULL;
END;
$$;

ALTER FUNCTION "public"."integration_order_event_notify"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."integration_order_event_notify"() FROM PUBLIC, "anon", "authenticated";

CREATE TRIGGER "integration_order_event_notify"
    AFTER INSERT OR UPDATE OF "status" ON "public"."integration_order_event"
    FOR EACH ROW
    WHEN (NEW.status = 'pending' AND NEW.next_attempt_at <= now())
    EXECUTE FUNCTION "public"."integration_order_event_notify"();

-- ── Packages: the storefront order they came from ────────────────────────────

-- Links a package to its storefront order. The unique index allows one
-- package per order, even for a webhook sent twice with different
-- Idempotency-Keys.
ALTER TABLE "public"."packages"
    ADD COLUMN "external_platform"   "text",
    ADD COLUMN "external_order_id"   "text",
    ADD COLUMN "external_order_name" "text",
    ADD CONSTRAINT "packages_external_order_check" CHECK (
        ("external_platform" IS NULL) = ("external_order_id" IS NULL)
    );

COMMENT ON COLUMN "public"."packages"."external_platform" IS
    'Connector slug (e.g. "shopify") of the storefront order this package was created from. NULL for packages created by hand or by a booking.';
COMMENT ON COLUMN "public"."packages"."external_order_id" IS
    'The order''s id in the storefront (Shopify: its GraphQL global id). Unique per organisation and platform.';
COMMENT ON COLUMN "public"."packages"."external_order_name" IS
    'The storefront''s human-facing order number, e.g. "#1001".';

CREATE UNIQUE INDEX "packages_org_external_order_key"
    ON "public"."packages" ("organisation_id", "external_platform", "external_order_id")
    WHERE "external_order_id" IS NOT NULL;
