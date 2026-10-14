-- Tell hikyaku-api when something that shapes a shop's static checkout
-- rates or coverage changes, so it can push a resync to the storefront app.
-- See src/integrations/static-rates/static-rates-push.service.ts.
--
-- Service areas and their staffing are written through PostgREST by the
-- dashboard, not through the API, so the database is the one place that
-- sees every change. Each trigger sends
--
--   pg_notify('hikyaku_static_rates', '<organisation_id>|<reason>[|<platform>|<shop_domain>]')
--
-- and the API coalesces a burst into one push per shop. NOTIFY is sent at
-- COMMIT, and Postgres drops duplicate payloads within a transaction, so a
-- bulk edit costs one notification per organisation and reason. Catalog
-- changes live in Stripe, so the API notifies for those itself.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION "public"."static_rates_changed_notify"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    r      record;
    reason text := TG_ARGV[0];
BEGIN
    IF TG_OP = 'DELETE' THEN
        r := OLD;
    ELSE
        r := NEW;
    END IF;

    IF r.organisation_id IS NOT NULL THEN
        IF TG_TABLE_NAME IN ('integration_location_mapping', 'integration_shipping_rate_settings') THEN
            -- One shop's rows: only that shop needs a resync.
            PERFORM pg_notify('hikyaku_static_rates',
                r.organisation_id::text || '|' || reason || '|' || r.platform || '|' || r.shop_domain);
        ELSE
            PERFORM pg_notify('hikyaku_static_rates', r.organisation_id::text || '|' || reason);
        END IF;
    END IF;

    -- A row moved to another organisation changes the old one too.
    IF TG_OP = 'UPDATE' AND OLD.organisation_id IS NOT NULL
       AND OLD.organisation_id IS DISTINCT FROM NEW.organisation_id THEN
        PERFORM pg_notify('hikyaku_static_rates', OLD.organisation_id::text || '|' || reason);
    END IF;

    RETURN NULL;
END;
$$;

ALTER FUNCTION "public"."static_rates_changed_notify"() OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."static_rates_changed_notify"() FROM PUBLIC, "anon", "authenticated";

COMMENT ON FUNCTION "public"."static_rates_changed_notify"() IS
    'NOTIFY hikyaku_static_rates with "<organisation_id>|<reason>[|<platform>|<shop_domain>]" when a table that shapes static checkout rates or coverage changes. TG_ARGV[0] is the reason. hikyaku-api listens and pushes a resync to the storefront app.';

-- Territories: geometry, retiring and un-retiring.
DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."service_areas";
CREATE TRIGGER "static_rates_changed"
    AFTER INSERT OR UPDATE OR DELETE ON "public"."service_areas"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('service_areas');

-- Staffing: which drivers work which territory, which decides floaters.
DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."driver_service_area";
CREATE TRIGGER "static_rates_changed"
    AFTER INSERT OR UPDATE OR DELETE ON "public"."driver_service_area"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('drivers');

-- Drivers joining, leaving or moving warehouse. Not every column: drivers
-- rows change for reasons that don't touch coverage.
DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."drivers";
CREATE TRIGGER "static_rates_changed"
    AFTER INSERT OR DELETE OR UPDATE OF "warehouse_id", "organisation_id" ON "public"."drivers"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('drivers');

-- Warehouses moving: the Function measures distance from them.
DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."warehouse";
CREATE TRIGGER "static_rates_changed"
    AFTER UPDATE OF "warehouse_location" ON "public"."warehouse"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('warehouses');

-- Service area matching on or off.
DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."organisation_dispatch_settings";
CREATE TRIGGER "static_rates_changed"
    AFTER INSERT OR DELETE OR UPDATE OF "service_area_matching" ON "public"."organisation_dispatch_settings"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('dispatch_settings');

DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."integration_location_mapping";
CREATE TRIGGER "static_rates_changed"
    AFTER INSERT OR UPDATE OR DELETE ON "public"."integration_location_mapping"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('locations');

DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."integration_shipping_rate_settings";
CREATE TRIGGER "static_rates_changed"
    AFTER INSERT OR UPDATE OR DELETE ON "public"."integration_shipping_rate_settings"
    FOR EACH ROW EXECUTE FUNCTION "public"."static_rates_changed_notify"('settings');
