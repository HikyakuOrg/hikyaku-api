-- Turns integration_order_event from a record-only ledger into a work queue:
-- every recorded order event is now processed, asynchronously, into a
-- customer + package that is then assigned to a shift. See
-- src/integrations/order-event.worker.ts.
--
-- The ledger row itself is the unit of work. The webhook endpoint stays
-- record-only and fast (Shopify gives the whole round trip 5 s, and a single
-- Photon lookup alone can take longer than that), and a worker claims pending
-- rows afterwards with FOR UPDATE SKIP LOCKED, so any number of API replicas
-- can drain it without processing a row twice.

-- ── Ledger: processing state ─────────────────────────────────────────────────

-- Existing rows take the default and become 'pending', so an event recorded
-- before this migration ran is processed like any other.
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
    -- SET NULL, never CASCADE: deleting the package a dispatcher no longer
    -- wants must not erase the evidence that the order was received.
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

-- The worker's claim query: pending rows that are due, plus processing rows
-- whose claim has gone stale (a worker that died mid-row).
CREATE INDEX "integration_order_event_work_idx"
    ON "public"."integration_order_event" ("next_attempt_at")
    WHERE "status" IN ('pending', 'processing');

-- The dashboard's "orders that need a human" list.
CREATE INDEX "integration_order_event_org_status_idx"
    ON "public"."integration_order_event" ("organisation_id", "status", "created_at" DESC);

-- ── Wake-up ──────────────────────────────────────────────────────────────────

-- NOTIFY is the doorbell, the table is the truth: the worker also sweeps on a
-- timer, so a notification delivered to nobody (listener reconnecting) costs
-- latency, never an order. Firing on UPDATE too means a row put back to
-- pending by hand, or by the retry endpoint, is picked up immediately.
-- Postgres holds the NOTIFY until COMMIT, so the worker never wakes for a row
-- it cannot see yet.
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

-- So ops can match a package back to the order in the storefront admin, and
-- so the database itself guarantees one package per external order: a
-- webhook delivered twice under two different Idempotency-Keys still cannot
-- put the same parcel on a van twice.
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
