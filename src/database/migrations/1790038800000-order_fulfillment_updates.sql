-- Re-routing after payment: an order.fulfillment_updated event carries the
-- order's current groups, and the processor reconciles the order's packages
-- with them. See src/integrations/order-event.processor.ts.
--
-- Processing reads all events of an order, so the ledger gets an index on
-- the order. No column changes: a re-routed package is deleted, not marked,
-- which frees packages_org_external_fulfillment_key for its replacement.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS "integration_order_event_order_idx"
    ON "public"."integration_order_event" (
        "organisation_id",
        "platform",
        "external_order_id",
        "created_at"
    );

COMMENT ON COLUMN "public"."integration_order_event"."event_type" IS
    'order.paid: creates the order''s packages. order.fulfillment_updated: the storefront re-routed the order after payment; its packages are reconciled with the fulfillment groups it carries. Any other type is recorded and skipped.';

COMMENT ON COLUMN "public"."integration_order_event"."status" IS
    'Processing state. pending: waiting for the worker (again, after a transient failure, once next_attempt_at passes). processing: claimed by a worker at claimed_at. processed: integration_order_event_package and customer_id say what it produced. skipped: nothing to deliver (digital or pickup-only order, every group picked up or from a location Hikyaku does not deliver for, an order.fulfillment_updated for an order whose order.paid has not arrived, or an event type that creates nothing); error says why. needs_attention: cannot be fully processed without a human (ungeocodable address, no warehouse, a fulfillment location not mapped to a warehouse, a re-routing that touches a package already loaded or delivered); error says why, the groups that could be processed already have their packages, and POST /api/v1/integrations/orders/:id/retry re-queues the rest. failed: transient failures exhausted the retry budget.';
