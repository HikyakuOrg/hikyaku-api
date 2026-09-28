-- Maps each storefront location to the warehouse that dispatches its items,
-- marks it as not delivered, or leaves it unmapped.
--
-- Contents:
--   1. UNIQUE (organisation_id, id) on warehouse, the target of a composite
--      foreign key that keeps a mapping and its warehouse in one organisation.
--   2. integration_location_mapping, one row per storefront location.
--   3. A trigger that unmaps a mapping when its warehouse is deleted.
--   4. The integrations.locations.write permission.
--   5. RLS and grants: hikyaku-api only, like integration_order_event.
--
-- `platform` is a caller-supplied connector slug, as on
-- integration_order_event, so a new connector needs no migration.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. warehouse (organisation_id, id) ──────────────────────────────────────
--
-- id is already unique, so this cannot fail on existing rows. The composite
-- foreign key below needs it: the database then refuses a mapping that points
-- at another organisation's warehouse.
--
-- Guarded, not dropped and re-added: once the foreign key exists, the
-- constraint cannot be dropped, and this file must be safe to re-run.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.warehouse'::regclass
           AND conname = 'warehouse_organisation_id_id_key'
    ) THEN
        ALTER TABLE "public"."warehouse"
            ADD CONSTRAINT "warehouse_organisation_id_id_key"
            UNIQUE ("organisation_id", "id");
    END IF;
END;
$$;

-- ── 2. The table ─────────────────────────────────────────────────────────────
--
-- mode is text with a CHECK, not an enum, like
-- organisation_dispatch_settings.assignment_mode, so a new mode is a
-- constraint swap. New rows start `unmapped`: connectors register locations,
-- and only a person maps them.
--
-- warehouse_id is set exactly when mode is `warehouse` (mode_warehouse_chk).
--
-- The composite warehouse foreign key keeps the warehouse in the mapping's
-- organisation. On a warehouse delete, ON DELETE SET NULL (warehouse_id)
-- clears only that column, and the section 3 trigger sets mode to
-- `unmapped`. Orders from the location then need attention until someone
-- maps it again.
--
-- stale_at is set when the connector's full location list for the shop omits
-- this location. The row keeps its mapping, because older orders can still
-- arrive and the location can come back. The next report clears it.
--
-- external_location_name and country_code (ISO 3166-1 alpha-2) are display
-- only and refresh on every sync.
--
-- updated_by has no foreign key to auth.users, like
-- organisation_dispatch_settings.updated_by: it is an audit field, and a user
-- delete must not fail on it or change it.

CREATE TABLE IF NOT EXISTS "public"."integration_location_mapping" (
    "id"                     uuid        NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id"        uuid        NOT NULL,
    "platform"               text        NOT NULL,
    "shop_domain"            text        NOT NULL,
    "external_location_id"   text        NOT NULL,
    "external_location_name" text,
    "country_code"           text,
    "mode"                   text        NOT NULL DEFAULT 'unmapped',
    "warehouse_id"           uuid,
    "stale_at"               timestamptz,
    "created_at"             timestamptz NOT NULL DEFAULT now(),
    "updated_at"             timestamptz NOT NULL DEFAULT now(),
    "updated_by"             uuid,

    CONSTRAINT "integration_location_mapping_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "integration_location_mapping_location_key"
        UNIQUE ("organisation_id", "platform", "shop_domain", "external_location_id"),

    CONSTRAINT "integration_location_mapping_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE,

    CONSTRAINT "integration_location_mapping_warehouse_fkey"
        FOREIGN KEY ("organisation_id", "warehouse_id")
        REFERENCES "public"."warehouse" ("organisation_id", "id")
        ON DELETE SET NULL ("warehouse_id"),

    CONSTRAINT "integration_location_mapping_mode_chk"
        CHECK ("mode" IN ('warehouse', 'not_delivered', 'unmapped')),

    CONSTRAINT "integration_location_mapping_mode_warehouse_chk"
        CHECK (("mode" = 'warehouse') = ("warehouse_id" IS NOT NULL)),

    CONSTRAINT "integration_location_mapping_country_code_chk"
        CHECK ("country_code" ~ '^[A-Z]{2}$')
);

ALTER TABLE "public"."integration_location_mapping" OWNER TO "postgres";

-- For the foreign key's lookups on a warehouse delete. The unique constraint
-- covers the API's reads, which all lead with organisation_id.
CREATE INDEX IF NOT EXISTS "integration_location_mapping_warehouse_id_idx"
    ON "public"."integration_location_mapping" ("warehouse_id")
    WHERE "warehouse_id" IS NOT NULL;

COMMENT ON TABLE "public"."integration_location_mapping" IS
    'Which warehouse dispatches the items a storefront fulfils from each of its locations. One row per (organisation, platform, shop_domain, external_location_id), written by storefront connectors and the mapping UI through PUT /api/v1/integrations/locations. See src/integrations/location-mappings.service.ts.';

COMMENT ON COLUMN "public"."integration_location_mapping"."platform" IS
    'Lowercase connector slug (e.g. "shopify"), supplied by the caller. An open data value, as on integration_order_event: a new connector needs no migration.';

COMMENT ON COLUMN "public"."integration_location_mapping"."shop_domain" IS
    'The storefront the location belongs to, e.g. "store.myshopify.com". One organisation can connect several stores on the same platform.';

COMMENT ON COLUMN "public"."integration_location_mapping"."external_location_id" IS
    'The location''s id in the storefront''s own system, e.g. "gid://shopify/Location/123".';

COMMENT ON COLUMN "public"."integration_location_mapping"."mode" IS
    '`warehouse`: items fulfilled from this location are dispatched from warehouse_id. `not_delivered`: Hikyaku does not deliver for this location, so its items are left alone. `unmapped`: nobody has decided yet, or the warehouse it pointed at was deleted; its orders need attention.';

COMMENT ON COLUMN "public"."integration_location_mapping"."warehouse_id" IS
    'Set exactly when mode is `warehouse`, and always a warehouse of the same organisation (composite foreign key). Deleting that warehouse clears it and sets mode to `unmapped`.';

COMMENT ON COLUMN "public"."integration_location_mapping"."stale_at" IS
    'When the connector last sent its full list of locations for this shop without this one. NULL while the storefront still reports it. The row and its mapping are kept.';

COMMENT ON COLUMN "public"."integration_location_mapping"."updated_by" IS
    'Id of the user whose request last changed the row. NULL when the database changed it on its own, such as after the mapped warehouse was deleted.';

-- ── 3. Deleted warehouse -> unmapped ────────────────────────────────────────
--
-- ON DELETE SET NULL clears only warehouse_id, which fails
-- mode_warehouse_chk and blocks the warehouse delete. This trigger sets mode
-- to `unmapped` in the same row update.
--
-- It acts only when pg_trigger_depth() > 1, which is how Postgres runs
-- referential actions. A plain UPDATE that clears warehouse_id but keeps mode
-- `warehouse` still fails the CHECK, because that is a bug in the caller.

CREATE OR REPLACE FUNCTION "public"."integration_location_mapping_unmap_deleted_warehouse"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN
        NEW.mode := 'unmapped';
        NEW.updated_at := now();
        NEW.updated_by := NULL;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."integration_location_mapping_unmap_deleted_warehouse"() IS
    'Moves a mapping to mode `unmapped` when the ON DELETE SET NULL action of its warehouse foreign key clears warehouse_id, so deleting a warehouse unmaps its storefront locations instead of failing on the mode/warehouse CHECK.';

DROP TRIGGER IF EXISTS "integration_location_mapping_unmap_deleted_warehouse" ON "public"."integration_location_mapping";

CREATE TRIGGER "integration_location_mapping_unmap_deleted_warehouse"
    BEFORE UPDATE OF "warehouse_id" ON "public"."integration_location_mapping"
    FOR EACH ROW
    WHEN (OLD."warehouse_id" IS NOT NULL AND NEW."warehouse_id" IS NULL AND NEW."mode" = 'warehouse')
    EXECUTE FUNCTION "public"."integration_location_mapping_unmap_deleted_warehouse"();

-- ── 4. integrations.locations.write ─────────────────────────────────────────
--
-- A new permission, not integrations.orders.write: mapping a location
-- changes every future order from it, so an organisation can grant the two
-- separately.
--
-- MAX(id)+1, not the identity default, as in
-- AddIntegrationsOrdersWritePermission1789261400000: the sequence never
-- advanced past the numbered seed rows.
--
-- WHERE NOT EXISTS makes the insert safe to re-run.
INSERT INTO "public"."app_permission" ("id", "permission")
SELECT (SELECT MAX("id") FROM "public"."app_permission") + 1, 'integrations.locations.write'
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."app_permission" WHERE "permission" = 'integrations.locations.write'
);

-- handle_new_organisation() gives a new organisation's creator every
-- permission. For existing organisations, grant it to every holder of
-- integrations.orders.write, so connectors can sync locations without a
-- manual grant.
INSERT INTO "public"."user_permission" ("organisation_id", "user_id", "permission_id")
SELECT up."organisation_id", up."user_id", new_perm."id"
FROM "public"."user_permission" up
JOIN "public"."app_permission" existing
    ON existing."id" = up."permission_id" AND existing."permission" = 'integrations.orders.write'
CROSS JOIN (
    SELECT "id" FROM "public"."app_permission" WHERE "permission" = 'integrations.locations.write'
) new_perm
ON CONFLICT DO NOTHING;

-- ── 5. RLS and grants ────────────────────────────────────────────────────────
--
-- RLS on with no policies, and no anon or authenticated access, like
-- integration_order_event. Only hikyaku-api (service_role, which bypasses
-- RLS) reads and writes, scoped to the organisation PermissionGuard resolved.

ALTER TABLE "public"."integration_location_mapping" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."integration_location_mapping" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."integration_location_mapping" TO "service_role";
