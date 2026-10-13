-- The Hikyaku checkout rate a storefront order paid for, on each package the
-- order makes. See src/integrations/order-event.processor.ts.
--
-- All NULL for a package that did not come from a Hikyaku checkout rate:
-- created by hand, by a booking, or from a shop without rates.
--
-- The price is the ORDER's shipping line. An order split into several
-- packages (one per fulfillment group) repeats it on each, so it must not be
-- summed across packages.
--
-- New nullable columns with no default: a metadata-only change, no rewrite.
-- The table's existing grants and RLS policies cover them.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "public"."packages"
    ADD COLUMN IF NOT EXISTS "shipping_service_id" "text",
    ADD COLUMN IF NOT EXISTS "shipping_service_name" "text",
    ADD COLUMN IF NOT EXISTS "shipping_price_minor" bigint,
    ADD COLUMN IF NOT EXISTS "shipping_discounted_price_minor" bigint,
    ADD COLUMN IF NOT EXISTS "shipping_currency" "text",
    ADD COLUMN IF NOT EXISTS "shipping_rate_path" "text";

ALTER TABLE "public"."packages"
    DROP CONSTRAINT IF EXISTS "packages_shipping_rate_check";
ALTER TABLE "public"."packages"
    ADD CONSTRAINT "packages_shipping_rate_check" CHECK (
        ("shipping_rate_path" IS NULL OR "shipping_rate_path" IN ('live', 'static'))
        AND ("shipping_currency" IS NULL OR "shipping_currency" ~ '^[A-Z]{3}$')
        AND ("shipping_price_minor" IS NULL OR "shipping_price_minor" >= 0)
        AND ("shipping_discounted_price_minor" IS NULL OR "shipping_discounted_price_minor" >= 0)
        -- A price always comes with its currency and service.
        AND ("shipping_price_minor" IS NULL
             OR ("shipping_currency" IS NOT NULL AND "shipping_service_id" IS NOT NULL))
    ) NOT VALID;

-- Existing rows are all NULL in these columns, so validation cannot fail.
ALTER TABLE "public"."packages"
    VALIDATE CONSTRAINT "packages_shipping_rate_check";

COMMENT ON COLUMN "public"."packages"."shipping_service_id" IS
    'Stripe product id of the catalog service the shopper chose as a checkout rate. NULL when the package did not come from a Hikyaku checkout rate.';
COMMENT ON COLUMN "public"."packages"."shipping_service_name" IS
    'The shipping line title the shopper saw at checkout.';
COMMENT ON COLUMN "public"."packages"."shipping_price_minor" IS
    'Shipping the shopper was charged for the whole order, before discounts, in shipping_currency minor units. Repeated on each package of a split order: do not sum.';
COMMENT ON COLUMN "public"."packages"."shipping_discounted_price_minor" IS
    'The same, after discounts.';
COMMENT ON COLUMN "public"."packages"."shipping_currency" IS
    'Upper-case ISO 4217 currency of the shipping prices.';
COMMENT ON COLUMN "public"."packages"."shipping_rate_path" IS
    '`live`: priced by the carrier callback. `static`: a rate written into the storefront.';
