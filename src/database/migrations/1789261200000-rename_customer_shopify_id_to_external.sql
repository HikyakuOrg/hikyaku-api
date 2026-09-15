-- Renames customer.shopify_customer_id to customer.external_customer_id and
-- adds customer.external_platform, so the customer table stops naming Shopify
-- specifically. Part of HIK-99 (generic ecommerce connector): every future
-- storefront integration (WooCommerce, Magento, MedusaJS) links back through
-- these same two columns, with the platform carried as a data value rather
-- than baked into a column name.
--
-- Free rename: this column has never held real data in any environment.

ALTER TABLE "public"."customer"
    RENAME COLUMN "shopify_customer_id" TO "external_customer_id";

ALTER TABLE "public"."customer"
    ADD COLUMN "external_platform" "text";

-- The pair links a customer to one row in one external platform's system. A
-- platform with no id, or an id with no platform, is not a legal link.
ALTER TABLE "public"."customer"
    ADD CONSTRAINT "customer_external_platform_id_check"
    CHECK (("external_platform" IS NULL) = ("external_customer_id" IS NULL));

DROP INDEX IF EXISTS "public"."customer_shopify_customer_id_idx";

-- Org-scoped composite lookup, replacing the old single-column shopify index.
-- Platform is included because external_customer_id is only unique within one
-- platform's id space, not across all of them.
CREATE INDEX "customer_org_external_idx"
    ON "public"."customer" USING "btree" ("organisation_id", "external_platform", "external_customer_id")
    WHERE ("external_customer_id" IS NOT NULL);
