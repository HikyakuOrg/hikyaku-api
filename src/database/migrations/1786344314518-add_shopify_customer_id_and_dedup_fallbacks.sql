-- Adds a Shopify buyer-id link column (mirrors stripe_customer_id: a plain
-- nullable text link, populated when a Shopify order upserts this row) plus
-- two additional exact-match dedup fallback tiers below the existing
-- phone-based one. Needed because Shopify's delivery.phone is frequently
-- absent (unlike hikyaku-native bookings, where phone is mandatory), so
-- without a fallback every phoneless repeat Shopify customer would become a
-- fresh duplicate row forever.
--
-- Fallback tiers are strictly ordered by reliability and deliberately scoped
-- so a weaker tier can only ever merge into an equally-weak row, never
-- override one that already has stronger verified data:
--   1. phone            (existing customer_org_phone_unique, unchanged)
--   2. email, when phone is absent
--   3. name,  when both phone and email are absent
--
-- See src/customers/customers.service.ts (upsertCustomerRow) for the
-- application-side ON CONFLICT logic that targets these indexes.

ALTER TABLE "public"."customer"
    ADD COLUMN "shopify_customer_id" "text";

CREATE INDEX "customer_shopify_customer_id_idx"
    ON "public"."customer" USING "btree" ("shopify_customer_id")
    WHERE ("shopify_customer_id" IS NOT NULL);

CREATE UNIQUE INDEX "customer_org_email_unique"
    ON "public"."customer" USING "btree" ("organisation_id", "lower"("customer_email"))
    WHERE ("customer_email" IS NOT NULL AND "customer_phone" IS NULL);

CREATE UNIQUE INDEX "customer_org_name_unique"
    ON "public"."customer" USING "btree" ("organisation_id", "lower"("customer_name"))
    WHERE ("customer_name" IS NOT NULL AND "customer_phone" IS NULL AND "customer_email" IS NULL);
