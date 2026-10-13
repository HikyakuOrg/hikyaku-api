-- Checkout shipping rates per storefront shop, and the location addresses
-- the carrier rate callback matches its origin against.
--
-- Contents:
--   1. integration_shipping_rate_settings, one row per (platform, shop_domain).
--   2. integration_location_mapping.address.
--   3. The integrations.shipping_rates.write permission.
--   4. RLS and grants: hikyaku-api only, like integration_location_mapping.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. The settings table ────────────────────────────────────────────────────
--
-- (platform, shop_domain) is unique across organisations, not per
-- organisation. The storefront's carrier callback (POST
-- /api/v1/integrations/shopify/carrier-rates) carries only the shop, and this
-- row is how it finds the organisation. A shop already held by another
-- organisation is refused (409) until that organisation deletes the row, so
-- one org cannot put its rates on another org's shop.
--
-- service_ids are Stripe product ids of the organisation's catalog services,
-- in the order the merchant chose. They are not foreign keys: the catalog
-- lives in Stripe. A service archived later is skipped at quote time.
--
-- shop_currency is upper-case ISO 4217, as storefronts report it. Every rate
-- is priced in it, from the Stripe price's main amount or currency_options.
--
-- path is which Shopify surface carries the rates: `live` (carrier service)
-- or `static` (delivery profile rates). NULL until the connector decides.
--
-- band_settings is keyed by service id: { "band_width": n, "max": n } in the
-- service's own unit (km, mi, kg or lb). The static path needs one for each
-- distance and weight service.

CREATE TABLE IF NOT EXISTS "public"."integration_shipping_rate_settings" (
    "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" uuid        NOT NULL,
    "platform"        text        NOT NULL,
    "shop_domain"     text        NOT NULL,
    "shop_currency"   text,
    "enabled"         boolean     NOT NULL DEFAULT false,
    "service_ids"     text[]      NOT NULL DEFAULT '{}',
    "path"            text,
    "band_settings"   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    "created_at"      timestamptz NOT NULL DEFAULT now(),
    "updated_at"      timestamptz NOT NULL DEFAULT now(),
    "updated_by"      uuid,

    CONSTRAINT "integration_shipping_rate_settings_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "integration_shipping_rate_settings_shop_key"
        UNIQUE ("platform", "shop_domain"),

    CONSTRAINT "integration_shipping_rate_settings_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE,

    CONSTRAINT "integration_shipping_rate_settings_path_chk"
        CHECK ("path" IN ('live', 'static')),

    CONSTRAINT "integration_shipping_rate_settings_currency_chk"
        CHECK ("shop_currency" ~ '^[A-Z]{3}$'),

    CONSTRAINT "integration_shipping_rate_settings_band_settings_chk"
        CHECK (jsonb_typeof("band_settings") = 'object'),

    -- Enabled rates must be priceable: a currency and at least one service.
    CONSTRAINT "integration_shipping_rate_settings_enabled_chk"
        CHECK (NOT "enabled" OR ("shop_currency" IS NOT NULL AND cardinality("service_ids") > 0))
);

ALTER TABLE "public"."integration_shipping_rate_settings" OWNER TO "postgres";

-- For the organisation's own reads (static plan, change push).
CREATE INDEX IF NOT EXISTS "integration_shipping_rate_settings_organisation_id_idx"
    ON "public"."integration_shipping_rate_settings" ("organisation_id");

COMMENT ON TABLE "public"."integration_shipping_rate_settings" IS
    'Which catalog services a storefront shop offers as checkout shipping rates. One row per (platform, shop_domain) across all organisations: the carrier callback resolves the organisation from it. Written through PUT /api/v1/integrations/shipping-rates. See src/integrations/shipping-rate-settings.service.ts.';

COMMENT ON COLUMN "public"."integration_shipping_rate_settings"."service_ids" IS
    'Stripe product ids of the organisation''s catalog services, in display order. Not foreign keys: the catalog lives in Stripe.';

COMMENT ON COLUMN "public"."integration_shipping_rate_settings"."shop_currency" IS
    'Upper-case ISO 4217 currency of the shop. Rates are priced only in it, never converted.';

COMMENT ON COLUMN "public"."integration_shipping_rate_settings"."path" IS
    '`live`: the storefront asks hikyaku-api per checkout (carrier service). `static`: rates are written into the storefront (delivery profiles). NULL until the connector decides.';

COMMENT ON COLUMN "public"."integration_shipping_rate_settings"."band_settings" IS
    'Static path band sizes by service id: { "band_width": n, "max": n } in the service''s unit (km, mi, kg or lb).';

-- ── 2. Location address ──────────────────────────────────────────────────────
--
-- A carrier rate request carries the origin's address but not its location
-- id, so the callback finds the location by address. Connectors send it with
-- each location sync. jsonb with the keys address1, address2, city,
-- province_code, zip and country_code, each a string or null. Display data
-- otherwise, like external_location_name.

ALTER TABLE "public"."integration_location_mapping"
    ADD COLUMN IF NOT EXISTS "address" jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.integration_location_mapping'::regclass
           AND conname = 'integration_location_mapping_address_chk'
    ) THEN
        ALTER TABLE "public"."integration_location_mapping"
            ADD CONSTRAINT "integration_location_mapping_address_chk"
            CHECK ("address" IS NULL OR jsonb_typeof("address") = 'object');
    END IF;
END;
$$;

COMMENT ON COLUMN "public"."integration_location_mapping"."address" IS
    'The location''s street address as the connector last sent it: { address1, address2, city, province_code, zip, country_code }. The carrier rate callback matches its origin against it, because the request has no location id.';

-- ── 3. integrations.shipping_rates.write ────────────────────────────────────
--
-- Its own permission: turning rates on changes what shoppers pay at checkout.
-- Same MAX(id)+1 and re-run guard as integrations.locations.write.
INSERT INTO "public"."app_permission" ("id", "permission")
SELECT (SELECT MAX("id") FROM "public"."app_permission") + 1, 'integrations.shipping_rates.write'
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."app_permission" WHERE "permission" = 'integrations.shipping_rates.write'
);

-- Existing holders of integrations.orders.write get it too, so connected
-- shops can turn rates on without a manual grant.
INSERT INTO "public"."user_permission" ("organisation_id", "user_id", "permission_id")
SELECT up."organisation_id", up."user_id", new_perm."id"
FROM "public"."user_permission" up
JOIN "public"."app_permission" existing
    ON existing."id" = up."permission_id" AND existing."permission" = 'integrations.orders.write'
CROSS JOIN (
    SELECT "id" FROM "public"."app_permission" WHERE "permission" = 'integrations.shipping_rates.write'
) new_perm
ON CONFLICT DO NOTHING;

-- ── 4. RLS and grants ────────────────────────────────────────────────────────

ALTER TABLE "public"."integration_shipping_rate_settings" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."integration_shipping_rate_settings" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."integration_shipping_rate_settings" TO "service_role";
