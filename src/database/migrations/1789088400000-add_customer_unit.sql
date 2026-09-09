-- HIK-43: a first-class home for the subpremise line on a customer address.
--
-- customer_address holds the street line only, so a delivery to an apartment
-- block or an office tower arrives with no way for the driver to find the
-- actual door. Users who needed one have been typing it into the street line,
-- which is unparseable and pollutes re-geocoding and search. This column gives
-- the unit / suite / business name its own slot, beside the street rather than
-- inside it.
--
-- Nullable text, no default, no backfill: whether to parse existing street
-- lines for embedded units is deliberately deferred to HIK-50, so every
-- existing row reads NULL until then.
--
-- The unit is a last-metre instruction, not a geocoding input. It must never
-- feed routing, coverage checks or pelias_gid re-lookup — customer_location
-- stays the building centroid — so nothing downstream changes with this
-- migration. Dedup keys on phone, then email, then name, never on address, so
-- the column participates in no conflict target and needs no index.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "public"."customer"
    ADD COLUMN IF NOT EXISTS "customer_unit" text;

COMMENT ON COLUMN "public"."customer"."customer_unit" IS
    'Subpremise line (unit, suite or business name) for a building delivery. Last-metre instruction only — never part of the geocoded street line or routing.';
