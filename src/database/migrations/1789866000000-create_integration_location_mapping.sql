-- Which Hikyaku warehouse dispatches the items a storefront fulfils from each
-- of its locations. A merchant whose store ships from several locations (a
-- Shopify store with a Sydney and a Melbourne stock location, say) maps each
-- one to the warehouse that should carry those items, marks it as one Hikyaku
-- does not deliver for, or leaves it unmapped for now.
--
-- What ships here:
--   1. warehouse gains a UNIQUE (organisation_id, id), so a mapping can point
--      at a warehouse through a foreign key that also pins it to the same
--      organisation.
--   2. integration_location_mapping, one row per storefront location.
--   3. A trigger that turns a mapping whose warehouse was deleted into an
--      unmapped one instead of letting the delete fail or cascade.
--   4. integrations.locations.write, the permission that gates writing it.
--   5. RLS and grants: hikyaku-api only, like integration_order_event.
--
-- Nothing here is named after a platform. `platform` is a lowercase connector
-- slug supplied by the caller, as on integration_order_event, so WooCommerce
-- or Magento reuse this table without a migration.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. warehouse (organisation_id, id) ──────────────────────────────────────
--
-- id alone is already unique, so this can never fail on existing rows. It
-- exists only to be the target of the composite foreign key below: with it,
-- the database itself refuses a mapping in one organisation that points at
-- another organisation's warehouse, whatever the API checked first.
--
-- Guarded rather than dropped and re-added, because once the foreign key below
-- exists the constraint cannot be dropped, and this file has to survive being
-- re-run by hand.

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
-- mode is text plus a CHECK rather than a Postgres enum, like
-- organisation_dispatch_settings.assignment_mode, so a later mode is a
-- constraint swap rather than an ALTER TYPE. A new row starts `unmapped`: a
-- connector registers every location it knows about, and only a person decides
-- where each one ships from.
--
-- warehouse_id is set exactly when mode is `warehouse`, which the
-- mode_warehouse_chk constraint holds both ways.
--
-- The warehouse foreign key is composite, so the warehouse has to belong to
-- the mapping's own organisation. ON DELETE SET NULL (warehouse_id) clears
-- only that column (organisation_id stays), and the trigger in section 3 moves
-- mode to `unmapped` in the same update so the CHECK still holds. Orders from
-- that location then land in needs_attention until somebody maps it again,
-- rather than the mapping disappearing with the warehouse.
--
-- stale_at is set when the connector sends its full list of locations for a
-- shop and this one is not on it (closed or deleted on the storefront). The
-- row is kept, mapping and all, because orders placed before it closed can
-- still arrive, and the location may come back. It clears as soon as the
-- connector reports the location again.
--
-- external_location_name and country_code are display only, refreshed from
-- the storefront on every sync. country_code is ISO 3166-1 alpha-2.
--
-- updated_by has no foreign key to auth.users, for the reason
-- organisation_dispatch_settings.updated_by has none: it is an audit trail,
-- and deleting a user must neither fail on it nor rewrite it.

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

-- The foreign key's own lookups (a warehouse delete finding its mappings) go
-- through this; the unique constraint above already covers every read the
-- API makes, which always leads with organisation_id.
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
-- The foreign key's ON DELETE SET NULL action runs an UPDATE that clears
-- warehouse_id and nothing else, which on its own would fail the
-- mode_warehouse_chk constraint and so block the warehouse delete. This moves
-- mode to `unmapped` in the same row update.
--
-- Only for updates made by that action: pg_trigger_depth() > 1 means this
-- trigger was fired by a statement another trigger ran, which is how
-- Postgres runs referential actions. A plain UPDATE that clears warehouse_id
-- but leaves mode `warehouse` still fails the CHECK, as it should: it is a
-- bug in whoever wrote it, not a warehouse going away.

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
-- A new permission rather than integrations.orders.write reused: pushing an
-- order in and deciding which warehouse a storefront location ships from are
-- different jobs, and the second moves every future order from that location.
-- An organisation can now let somebody map locations without letting them
-- inject orders, or the reverse.
--
-- MAX(id)+1 rather than the identity default, for the reason
-- AddIntegrationsOrdersWritePermission1789261400000 gives: the sequence never
-- advanced past the explicitly numbered seed rows.
--
-- WHERE NOT EXISTS makes the insert safe to re-run by hand.
INSERT INTO "public"."app_permission" ("id", "permission")
SELECT (SELECT MAX("id") FROM "public"."app_permission") + 1, 'integrations.locations.write'
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."app_permission" WHERE "permission" = 'integrations.locations.write'
);

-- handle_new_organisation() grants every permission to an organisation's
-- creator, so new organisations are covered. For existing ones, backfill to
-- whoever already holds integrations.orders.write: a connector already
-- forwarding orders can then sync its locations on the next deploy without
-- anybody re-granting anything.
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
-- RLS enabled with no policies, and revoked from anon and authenticated, like
-- integration_order_event: every read and write goes through hikyaku-api
-- (service_role, which bypasses RLS), which scopes each query to the
-- organisation PermissionGuard resolved.

ALTER TABLE "public"."integration_location_mapping" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."integration_location_mapping" FROM "anon", "authenticated";
GRANT ALL ON TABLE "public"."integration_location_mapping" TO "service_role";
