-- HIK-80: the data model for HIK-36 (Limit Driver Driving Activity). Nothing
-- reads any of this yet — no resolver, no API surface, no dispatch change.
-- This ships purely so the web dashboard has a table to write dispatcher
-- policy into, exactly as it already writes service_areas.
--
-- What ships here:
--   1. driving_limit_profile — org-scoped, named, soft-deleted, carrying the
--      four nullable limits described on the parent epic. All four null is a
--      legal, no-op profile: a half-filled form must never silently become a
--      cap on the dimensions left blank.
--   2. drivers.driving_limit_profile_id, nullable, composite-FK'd so a
--      cross-tenant pairing is structurally impossible. See
--      CreateDriverServiceArea1788742800000 for the full argument for a
--      composite FK over a same_org() RLS function; it applies unchanged.
--   3. organisations.default_driving_limit_profile_id, the org-level fallback
--      a driver with no profile of their own resolves to. Same composite-FK
--      shape, using organisations.id as its own half of the pair.
--   4. RLS mirroring service_areas: is_org_member to read, an edit permission
--      to write.
--   5. enforce_driver_self_update_columns gains driving_limit_profile_id in
--      its guarded column list, so a driver cannot lift their own cap by
--      updating their own row.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RESOLVING THE OPEN QUESTION: drivers.update, not a new driving_limits.edit
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The parent epic left this open. Settled here as drivers.update, reused
-- rather than a new permission minted, for the same reason
-- CreateDriverServiceArea1788742800000 reused service_areas.edit instead of
-- inventing a coverage-specific one: assigning a driver to a policy and
-- authoring that policy are the same dispatcher job, and the two writes this
-- feature needs cannot be split across two permissions anyway.
--
-- Concretely: drivers.driving_limit_profile_id lives ON the drivers table, so
-- it is already governed by the existing "drivers update self or org
-- editors" RLS policy and by enforce_driver_self_update_columns, both of
-- which key off drivers.update. A new driving_limits.edit permission would
-- still have to be OR'd into that trigger's check to let a profile-only role
-- assign drivers to profiles, at which point the table's own RLS gains
-- nothing by naming a different permission from the one that governs the
-- column it feeds. Reusing drivers.update keeps one permission covering both
-- halves of "set this driver's limits" instead of two that must always be
-- granted together.
--
-- The cost is real and worth naming: it means driving_limit_profile
-- authorship cannot be granted to someone who should not also see licence
-- and probation fields. Nothing in this product currently splits driver
-- management that finely, and vehicles.update/service_areas.edit already
-- bundle comparably-distinct concerns (fleet composition, territory
-- drawing) under one permission each, so this is consistent with the
-- existing grain rather than a new exception to it.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. The table ─────────────────────────────────────────────────────────────
--
-- All four limits are integer seconds/metres/stops, matching vrp_route and
-- vrp_route_step's existing duration/service/waiting_time columns rather than
-- introducing numeric here. max_distance_m is METRES throughout, matching
-- haversineMeters, VROOM's max_distance, and the vrp_route_step.distance_m
-- HIK-81 will add — see the parent epic for why kilometres never appear below
-- the dispatcher-facing form.
--
-- Every limit CHECK allows NULL explicitly (null means "no limit on this
-- dimension") and is declared inline rather than NOT VALID + VALIDATE,
-- because CREATE TABLE produces an empty table in the same statement and
-- there is no existing row for a validation scan to find.
--
-- max_stops_chk hard-caps at 45 to match MAX_STOPS in src/dispatch/insertion.ts,
-- which bounds the O(n^2) insertion scan. A profile must never be able to
-- raise that ceiling, only tighten it, so the cap is enforced here rather
-- than trusted to application code.
--
-- driving_limit_profile_id_organisation_id_key exists only so drivers and
-- organisations below can each reference (id, organisation_id) with a
-- composite foreign key. It is not a lookup key.

CREATE TABLE IF NOT EXISTS "public"."driving_limit_profile" (
    "id"                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id"     uuid        NOT NULL,
    "name"                text        NOT NULL,
    "max_working_seconds" integer,
    "max_driving_seconds" integer,
    "max_distance_m"      integer,
    "max_stops"           integer,
    "created_at"          timestamptz NOT NULL DEFAULT now(),
    "updated_at"          timestamptz NOT NULL DEFAULT now(),
    "is_deleted"          boolean     NOT NULL DEFAULT false,

    CONSTRAINT "driving_limit_profile_pkey"
        PRIMARY KEY ("id"),

    CONSTRAINT "driving_limit_profile_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE,

    CONSTRAINT "driving_limit_profile_id_organisation_id_key"
        UNIQUE ("id", "organisation_id"),

    CONSTRAINT "driving_limit_profile_max_working_seconds_chk"
        CHECK ("max_working_seconds" IS NULL OR "max_working_seconds" > 0),

    CONSTRAINT "driving_limit_profile_max_driving_seconds_chk"
        CHECK ("max_driving_seconds" IS NULL OR "max_driving_seconds" > 0),

    CONSTRAINT "driving_limit_profile_max_distance_m_chk"
        CHECK ("max_distance_m" IS NULL OR "max_distance_m" > 0),

    CONSTRAINT "driving_limit_profile_max_stops_chk"
        CHECK ("max_stops" IS NULL OR ("max_stops" > 0 AND "max_stops" <= 45))
);

ALTER TABLE "public"."driving_limit_profile" OWNER TO "postgres";

COMMENT ON TABLE "public"."driving_limit_profile" IS
    'A dispatcher-authored fleet policy bounding a shift on up to four dimensions. All four limit columns nullable; NULL means no limit on that dimension, and a row with every limit NULL is a legal no-op. Enforced nowhere yet — see HIK-82 (resolver), HIK-83 (Tier 1) and HIK-84 (Tier 2), all behind the DRIVING_LIMITS flag.';

COMMENT ON COLUMN "public"."driving_limit_profile"."max_working_seconds" IS
    'Depot to depot elapsed time, including service time at each stop. Parameterises the hard-coded SHIFT_WINDOW_SECONDS in src/dispatch/insertion.ts once the flag is on.';

COMMENT ON COLUMN "public"."driving_limit_profile"."max_driving_seconds" IS
    'Road time only, excluding service and waiting. A different constraint from max_working_seconds: fatigue, not shift length. Maps to VROOM vehicle-level max_travel_time.';

COMMENT ON COLUMN "public"."driving_limit_profile"."max_distance_m" IS
    'METRES, not kilometres. Matches haversineMeters, VROOM''s max_distance, and vrp_route_step.distance_m so the distance path never has a unit conversion in the middle of it. Kilometres exist only in the dispatcher-facing form.';

COMMENT ON COLUMN "public"."driving_limit_profile"."max_stops" IS
    'May only tighten MAX_STOPS in src/dispatch/insertion.ts (45), never raise it — see driving_limit_profile_max_stops_chk.';

COMMENT ON COLUMN "public"."driving_limit_profile"."is_deleted" IS
    'Soft delete. Filtered in the query layer, never in RLS, matching vehicles.is_deleted and service_areas.is_deleted.';

COMMENT ON CONSTRAINT "driving_limit_profile_id_organisation_id_key" ON "public"."driving_limit_profile" IS
    'Exists only so drivers.driving_limit_profile_id and organisations.default_driving_limit_profile_id can each reference (id, organisation_id) with a composite foreign key. Not a lookup key.';

-- ── 2. Name unique per org, among non-deleted rows only ─────────────────────
--
-- Deliberately partial, unlike service_areas_org_name_key. A dispatcher who
-- retires "Standard metro" and later wants to author a fresh profile under
-- the same name should be able to, since profiles are edited and replaced far
-- more often than territories are redrawn — the product ships five of these
-- as starting templates a dispatcher is expected to open and rename.

CREATE UNIQUE INDEX IF NOT EXISTS "driving_limit_profile_org_name_key"
    ON "public"."driving_limit_profile" ("organisation_id", "name")
    WHERE NOT "is_deleted";

-- ── 3. updated_at trigger ────────────────────────────────────────────────────
--
-- Mirrors service_areas_touch (FixServiceAreaSchema1788656400000) down to the
-- naming and the unconditional, server-clock-only assignment.

CREATE OR REPLACE FUNCTION "public"."driving_limit_profile_touch"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."driving_limit_profile_touch"() IS
    'Sets driving_limit_profile.updated_at to now() on every UPDATE, including the PostgREST writes the web dashboard makes, which do not list the column.';

DROP TRIGGER IF EXISTS "driving_limit_profile_touch" ON "public"."driving_limit_profile";

CREATE TRIGGER "driving_limit_profile_touch"
    BEFORE UPDATE ON "public"."driving_limit_profile"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."driving_limit_profile_touch"();

-- ── 4. drivers.driving_limit_profile_id ──────────────────────────────────────
--
-- Nullable: most-specific-wins resolution (driver profile, then org default,
-- then no limit) treats NULL here as "defer to the org default", not as "no
-- limit" — that distinction belongs to HIK-82's resolver, not to this column.
--
-- The composite FK is added NOT VALID then VALIDATE, unlike the table above,
-- because drivers already has rows. Every one of them gets NULL in the new
-- column (no default), and MATCH SIMPLE — Postgres' default — does not
-- enforce a composite FK when any referencing column is NULL, so the
-- validation scan finds nothing to fail regardless of how many drivers exist.
-- The pattern is kept anyway because ADD CONSTRAINT ... NOT VALID takes its
-- ACCESS EXCLUSIVE lock without scanning, while VALIDATE CONSTRAINT scans
-- under SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes.
--
-- drivers already carries the UNIQUE (id, organisation_id) this references,
-- added by CreateDriverServiceArea1788742800000.

ALTER TABLE "public"."drivers"
    ADD COLUMN IF NOT EXISTS "driving_limit_profile_id" uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.drivers'::regclass
           AND conname  = 'drivers_driving_limit_profile_org_fkey'
    ) THEN
        ALTER TABLE "public"."drivers"
            ADD CONSTRAINT "drivers_driving_limit_profile_org_fkey"
            FOREIGN KEY ("driving_limit_profile_id", "organisation_id")
            REFERENCES "public"."driving_limit_profile" ("id", "organisation_id")
            ON DELETE SET NULL
            NOT VALID;

        ALTER TABLE "public"."drivers"
            VALIDATE CONSTRAINT "drivers_driving_limit_profile_org_fkey";
    END IF;
END;
$$;

COMMENT ON COLUMN "public"."drivers"."driving_limit_profile_id" IS
    'This driver''s own driving limit profile. NULL defers to organisations.default_driving_limit_profile_id, which in turn means no limit if the org has not set one either — see the HIK-82 resolver. ON DELETE SET NULL: deleting a profile a driver points at falls the driver back to the org default rather than failing the delete.';

CREATE INDEX IF NOT EXISTS "idx_drivers_driving_limit_profile_id"
    ON "public"."drivers" ("driving_limit_profile_id");

-- ── 5. organisations.default_driving_limit_profile_id ────────────────────────
--
-- Same composite-FK shape as above, with organisations.id standing in for its
-- own organisation_id half of the pair: an org's default profile must be one
-- of that org's own rows, and the FK makes pointing at another tenant's
-- profile structurally impossible rather than merely policy-forbidden.
--
-- organisations has no pre-existing UNIQUE (id, organisation_id) to reuse
-- because it has no organisation_id column — it IS the organisation, so its
-- own primary key already serves as the referenced pair's second half.

ALTER TABLE "public"."organisations"
    ADD COLUMN IF NOT EXISTS "default_driving_limit_profile_id" uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.organisations'::regclass
           AND conname  = 'organisations_default_driving_limit_profile_fkey'
    ) THEN
        ALTER TABLE "public"."organisations"
            ADD CONSTRAINT "organisations_default_driving_limit_profile_fkey"
            FOREIGN KEY ("default_driving_limit_profile_id", "id")
            REFERENCES "public"."driving_limit_profile" ("id", "organisation_id")
            ON DELETE SET NULL
            NOT VALID;

        ALTER TABLE "public"."organisations"
            VALIDATE CONSTRAINT "organisations_default_driving_limit_profile_fkey";
    END IF;
END;
$$;

COMMENT ON COLUMN "public"."organisations"."default_driving_limit_profile_id" IS
    'The profile a driver with no profile of their own resolves to. NULL means the org has not opted into any default, which means no limit — see the HIK-82 resolver. ON DELETE SET NULL: deleting the org''s current default falls every unprofiled driver back to no limit rather than failing the delete.';

-- ── 6. Guard driving_limit_profile_id against self-update ───────────────────
--
-- enforce_driver_self_update_columns (trigger trg_driver_self_update_columns)
-- already stops a driver without drivers.update from changing id,
-- organisation_id, warehouse_id or driver_under_probation on their own row.
-- driving_limit_profile_id joins that list for the same reason
-- driver_under_probation is on it: a driver setting their own cap defeats the
-- entire point of the feature, and "drivers update self or org editors"
-- otherwise lets any driver update any column on their own row, this one
-- included. The parent epic is explicit that a driver does not need to see,
-- let alone set, their own limits.

CREATE OR REPLACE FUNCTION "public"."enforce_driver_self_update_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF (SELECT auth.uid()) = OLD.id
       AND NOT public.has_org_permission(OLD.organisation_id, 'drivers.update') THEN
        IF NEW.id                        IS DISTINCT FROM OLD.id
           OR NEW.organisation_id        IS DISTINCT FROM OLD.organisation_id
           OR NEW.warehouse_id           IS DISTINCT FROM OLD.warehouse_id
           OR NEW.driver_under_probation IS DISTINCT FROM OLD.driver_under_probation
           OR NEW.driving_limit_profile_id IS DISTINCT FROM OLD.driving_limit_profile_id THEN
            RAISE EXCEPTION 'drivers may only update their own licence details';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- ── 7. RLS ────────────────────────────────────────────────────────────────────
--
-- Mirrors service_areas: any org member reads, drivers.update writes (see the
-- header for why that permission and not a new one). DROP then CREATE because
-- PostgreSQL has no CREATE POLICY IF NOT EXISTS, and this file has to survive
-- being re-run by hand.

ALTER TABLE "public"."driving_limit_profile" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "driving limit profile select org members" ON "public"."driving_limit_profile";
CREATE POLICY "driving limit profile select org members"
    ON "public"."driving_limit_profile"
    FOR SELECT TO "authenticated"
    USING ("public"."is_org_member"("organisation_id"));

DROP POLICY IF EXISTS "driving limit profile insert org" ON "public"."driving_limit_profile";
CREATE POLICY "driving limit profile insert org"
    ON "public"."driving_limit_profile"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text"));

DROP POLICY IF EXISTS "driving limit profile update org" ON "public"."driving_limit_profile";
CREATE POLICY "driving limit profile update org"
    ON "public"."driving_limit_profile"
    FOR UPDATE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text"))
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text"));

DROP POLICY IF EXISTS "driving limit profile delete org" ON "public"."driving_limit_profile";
CREATE POLICY "driving limit profile delete org"
    ON "public"."driving_limit_profile"
    FOR DELETE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text"));

-- ── 8. Grants ────────────────────────────────────────────────────────────────
--
-- Supabase carries `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA
-- public GRANT ALL ON TABLES TO anon` (infra/db/schema.sql), so this table
-- arrives with an anon grant whether or not anyone asked for one. Revoked:
-- there is no anon policy on this table and never will be — driving limits
-- are dispatcher configuration, not anything the booking site needs.
--
-- service_role keeps its grant. hikyaku-api only ever reads this table
-- (through the HIK-82 resolver, not written here), and that read is always
-- explicitly org-scoped SQL rather than relying on RLS, matching how
-- src/dispatch/coverage.ts reads driver_service_area.

REVOKE ALL ON TABLE "public"."driving_limit_profile" FROM "anon";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."driving_limit_profile" TO "authenticated";
GRANT ALL ON TABLE "public"."driving_limit_profile" TO "service_role";
