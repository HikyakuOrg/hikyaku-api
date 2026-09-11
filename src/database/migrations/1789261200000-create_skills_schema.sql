-- HIK-91: org-defined skills catalog, plus the two join tables that attach it
-- to vehicles and packages. See HIK-90 for the wider epic: the VROOM
-- translation layer (HIK-92) enforces a skill match as a hard constraint, a
-- package can only route onto a vehicle holding every skill it requires, and
-- this is the catalog and linking data that reads from.
--
-- Shape mirrors CreateDriverServiceArea1788742800000 deliberately: composite
-- foreign keys (vehicle_id/package_id, organisation_id) -> parent
-- (id, organisation_id), never a same_org() function, so a cross-tenant link
-- is structurally impossible for every role including service_role (which
-- bypasses RLS and is the role hikyaku-api connects as). See that migration's
-- header for the full argument against a same_org() function; it applies here
-- unchanged.
--
-- PERMISSION CHOICE: no new app_permission row is minted. HIK-95 places the
-- catalog UI inside Fleet > Vehicles rather than a generic Settings section,
-- specifically because skills are fleet capability data, not a standalone
-- resource; that product decision is reused here as the RLS decision too, so
-- writing to skills or vehicle_skills both require 'vehicles.update', the
-- same permission that already governs editing a vehicle's other fields.
-- package_skills instead requires 'packages.update', mirroring the resource
-- it attaches to. A brand new permission would need seeding into
-- role_permission for every existing role before any organisation could use
-- it, which is an out-of-band step no migration in this repo performs; reuse
-- avoids that gap entirely.
--
-- vehicles and packages each need a UNIQUE (id, organisation_id) purely so
-- the join tables' composite FKs have something to reference — see step 1.
-- skills is a brand new table, so its own (id, organisation_id) unique is
-- declared inline at CREATE TABLE time instead.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Parent unique constraints ─────────────────────────────────────────────
--
-- Neither vehicles nor packages carries a UNIQUE (id, organisation_id) today
-- (each has only a plain PRIMARY KEY (id)), so both gain one here for the
-- same structural reason drivers and service_areas gained theirs in
-- CreateDriverServiceArea1788742800000. Built under ACCESS EXCLUSIVE, bounded
-- by lock_timeout above; both tables are small enough (one row per vehicle
-- employed, one row per package ever created — indexed, not scanned, by this
-- statement) for that to be instant in practice. The pg_constraint guards
-- make this file safely re-runnable by hand: ADD CONSTRAINT has no
-- IF NOT EXISTS.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.vehicles'::regclass
           AND conname  = 'vehicles_id_organisation_id_key'
    ) THEN
        ALTER TABLE "public"."vehicles"
            ADD CONSTRAINT "vehicles_id_organisation_id_key"
            UNIQUE ("id", "organisation_id");
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.packages'::regclass
           AND conname  = 'packages_id_organisation_id_key'
    ) THEN
        ALTER TABLE "public"."packages"
            ADD CONSTRAINT "packages_id_organisation_id_key"
            UNIQUE ("id", "organisation_id");
    END IF;
END;
$$;

COMMENT ON CONSTRAINT "vehicles_id_organisation_id_key" ON "public"."vehicles" IS
    'Exists only so vehicle_skills can reference (id, organisation_id) with a composite foreign key, which is what makes a cross-tenant skill assignment impossible for every role including service_role. Not a lookup key. Dropping it breaks that FK.';

COMMENT ON CONSTRAINT "packages_id_organisation_id_key" ON "public"."packages" IS
    'Exists only so package_skills can reference (id, organisation_id) with a composite foreign key, which is what makes a cross-tenant skill requirement impossible for every role including service_role. Not a lookup key. Dropping it breaks that FK.';

-- ── 2. The catalog ───────────────────────────────────────────────────────────
--
-- archived_at, not a boolean is_deleted: historical vrp_solution/vrp_route
-- rows (and package_skills/vehicle_skills rows already written) can still
-- reference a retired skill, and a nullable timestamp both marks that and
-- records when it happened, for free. Filtering archived rows out of what an
-- organisation may newly assign is the CRUD layer's job (HIK-93), not RLS's or
-- a constraint's — exactly the split service_areas.is_deleted already uses
-- (see FixServiceAreaSchema1788656400000).
--
-- UNIQUE (organisation_id, name) is NOT partial on archived_at, so an
-- archived skill's name stays reserved rather than becoming reusable. Same
-- tradeoff service_areas_org_name_key made for the identical reason: the
-- alternative (a partial index) lets the name be reused but then makes the
-- archived history ambiguous (two rows, same org, same name, only one live).
-- Revisit together if either one does.

CREATE TABLE IF NOT EXISTS "public"."skills" (
    "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" uuid        NOT NULL,
    "name"            text        NOT NULL,
    "archived_at"     timestamptz,
    "created_at"      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "skills_pkey"
        PRIMARY KEY ("id"),

    CONSTRAINT "skills_id_organisation_id_key"
        UNIQUE ("id", "organisation_id"),

    CONSTRAINT "skills_organisation_id_name_key"
        UNIQUE ("organisation_id", "name"),

    CONSTRAINT "skills_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE
);

ALTER TABLE "public"."skills" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "skills_organisation_id_idx"
    ON "public"."skills" ("organisation_id");

COMMENT ON TABLE "public"."skills" IS
    'Per-organisation catalog of capability labels (e.g. "Fragile Handling", "Requires Liftgate"), assigned to vehicles via vehicle_skills and required by packages via package_skills. VROOM enforces the match as a hard constraint: a package can only route onto a vehicle holding every skill it requires. See HIK-90.';

COMMENT ON COLUMN "public"."skills"."archived_at" IS
    'Soft-delete. NULL means active and assignable. Historical vrp_solution/vrp_route/vehicle_skills/package_skills rows keep referencing a retired skill; the CRUD API filters archived rows out of what can be newly assigned, not RLS or a constraint.';

ALTER TABLE "public"."skills" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "skills select org members" ON "public"."skills";
CREATE POLICY "skills select org members"
    ON "public"."skills"
    FOR SELECT TO "authenticated"
    USING ("public"."is_org_member"("organisation_id"));

DROP POLICY IF EXISTS "skills insert org" ON "public"."skills";
CREATE POLICY "skills insert org"
    ON "public"."skills"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));

DROP POLICY IF EXISTS "skills update org" ON "public"."skills";
CREATE POLICY "skills update org"
    ON "public"."skills"
    FOR UPDATE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"))
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));

DROP POLICY IF EXISTS "skills delete org" ON "public"."skills";
CREATE POLICY "skills delete org"
    ON "public"."skills"
    FOR DELETE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));

REVOKE ALL ON TABLE "public"."skills" FROM "anon";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."skills" TO "authenticated";
GRANT ALL ON TABLE "public"."skills" TO "service_role";

-- ── 3. vehicle_skills ────────────────────────────────────────────────────────
--
-- Many-to-many, same as driver_service_area: one vehicle can hold several
-- skills, and one skill applies to several vehicles. organisation_id is
-- redundant with what the composite FKs already reach transitively through
-- vehicles and skills, and is kept for the same reason driver_service_area
-- keeps its own: it makes the ON DELETE CASCADE from a deleted organisation
-- direct rather than dependent on cascade ordering between two other tables.
--
-- ON DELETE CASCADE on both sides is deliberate, same warning as
-- driver_service_area: deleting a vehicle or hard-deleting a skill drops the
-- pairing with no tombstone. Vehicles are soft-deleted in practice
-- (vehicles.is_deleted), so the live path to losing this silently is
-- retiring a skill from the catalog itself — which is exactly why skills
-- soft-deletes via archived_at instead of ever being hard-deleted by the
-- application. The FK still allows a hard delete of a skill row directly; the
-- CRUD API in HIK-93 is expected never to expose one.

CREATE TABLE IF NOT EXISTS "public"."vehicle_skills" (
    "vehicle_id"      uuid        NOT NULL,
    "skill_id"        uuid        NOT NULL,
    "organisation_id" uuid        NOT NULL,
    "created_at"      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "vehicle_skills_pkey"
        PRIMARY KEY ("vehicle_id", "skill_id"),

    CONSTRAINT "vehicle_skills_vehicle_org_fkey"
        FOREIGN KEY ("vehicle_id", "organisation_id")
        REFERENCES "public"."vehicles" ("id", "organisation_id")
        ON DELETE CASCADE,

    CONSTRAINT "vehicle_skills_skill_org_fkey"
        FOREIGN KEY ("skill_id", "organisation_id")
        REFERENCES "public"."skills" ("id", "organisation_id")
        ON DELETE CASCADE,

    CONSTRAINT "vehicle_skills_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE
);

ALTER TABLE "public"."vehicle_skills" OWNER TO "postgres";

COMMENT ON TABLE "public"."vehicle_skills" IS
    'Which skills each vehicle holds. Many-to-many. Read by the VROOM translation layer (HIK-92) to build a vehicle''s skills array, and by coverage diagnostics (HIK-94) to explain a skills mismatch. See HIK-90.';

COMMENT ON COLUMN "public"."vehicle_skills"."organisation_id" IS
    'The organisation both parents belong to. Not client-trusted: the composite foreign keys to vehicles(id, organisation_id) and skills(id, organisation_id) make a value that disagrees with either parent impossible to insert, for every role including service_role.';

-- Reverse direction: "which vehicles hold this skill?", which is what
-- coverage diagnostics and the VROOM translation layer both ask. Leads with
-- skill_id and carries vehicle_id so that query is index-only. The primary
-- key already serves the forward direction ("what does this vehicle hold?")
-- and the cascade scan when a vehicle is deleted.
CREATE INDEX IF NOT EXISTS "vehicle_skills_skill_vehicle_idx"
    ON "public"."vehicle_skills" ("skill_id", "vehicle_id");

CREATE INDEX IF NOT EXISTS "vehicle_skills_organisation_id_idx"
    ON "public"."vehicle_skills" ("organisation_id");

ALTER TABLE "public"."vehicle_skills" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vehicle skills select org members" ON "public"."vehicle_skills";
CREATE POLICY "vehicle skills select org members"
    ON "public"."vehicle_skills"
    FOR SELECT TO "authenticated"
    USING ("public"."is_org_member"("organisation_id"));

DROP POLICY IF EXISTS "vehicle skills insert org" ON "public"."vehicle_skills";
CREATE POLICY "vehicle skills insert org"
    ON "public"."vehicle_skills"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));

DROP POLICY IF EXISTS "vehicle skills update org" ON "public"."vehicle_skills";
CREATE POLICY "vehicle skills update org"
    ON "public"."vehicle_skills"
    FOR UPDATE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"))
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));

DROP POLICY IF EXISTS "vehicle skills delete org" ON "public"."vehicle_skills";
CREATE POLICY "vehicle skills delete org"
    ON "public"."vehicle_skills"
    FOR DELETE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));

REVOKE ALL ON TABLE "public"."vehicle_skills" FROM "anon";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."vehicle_skills" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicle_skills" TO "service_role";

-- ── 4. package_skills ────────────────────────────────────────────────────────
--
-- Same shape as vehicle_skills, attached to packages instead. The primary
-- write path is hikyaku-api's POST /api/v1/packages (HIK-93), which connects
-- as service_role and so bypasses RLS entirely; the policies below exist for
-- the same reason vehicles' own policies exist despite most vehicle writes
-- also going through PostgREST directly from the dashboard — so a dispatcher
-- can read, and in future edit, a package's required skills straight from
-- Supabase without a hikyaku-api round trip.

CREATE TABLE IF NOT EXISTS "public"."package_skills" (
    "package_id"      uuid        NOT NULL,
    "skill_id"        uuid        NOT NULL,
    "organisation_id" uuid        NOT NULL,
    "created_at"      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "package_skills_pkey"
        PRIMARY KEY ("package_id", "skill_id"),

    CONSTRAINT "package_skills_package_org_fkey"
        FOREIGN KEY ("package_id", "organisation_id")
        REFERENCES "public"."packages" ("id", "organisation_id")
        ON DELETE CASCADE,

    CONSTRAINT "package_skills_skill_org_fkey"
        FOREIGN KEY ("skill_id", "organisation_id")
        REFERENCES "public"."skills" ("id", "organisation_id")
        ON DELETE CASCADE,

    CONSTRAINT "package_skills_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE
);

ALTER TABLE "public"."package_skills" OWNER TO "postgres";

COMMENT ON TABLE "public"."package_skills" IS
    'Which skills each package requires. Many-to-many, though a package usually names a handful. Read by the VROOM translation layer (HIK-92) to build a job''s skills array, and by coverage diagnostics (HIK-94) to explain a skills mismatch. See HIK-90.';

COMMENT ON COLUMN "public"."package_skills"."organisation_id" IS
    'The organisation both parents belong to. Not client-trusted: the composite foreign keys to packages(id, organisation_id) and skills(id, organisation_id) make a value that disagrees with either parent impossible to insert, for every role including service_role.';

CREATE INDEX IF NOT EXISTS "package_skills_skill_package_idx"
    ON "public"."package_skills" ("skill_id", "package_id");

CREATE INDEX IF NOT EXISTS "package_skills_organisation_id_idx"
    ON "public"."package_skills" ("organisation_id");

ALTER TABLE "public"."package_skills" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "package skills select org members" ON "public"."package_skills";
CREATE POLICY "package skills select org members"
    ON "public"."package_skills"
    FOR SELECT TO "authenticated"
    USING ("public"."is_org_member"("organisation_id"));

DROP POLICY IF EXISTS "package skills insert org" ON "public"."package_skills";
CREATE POLICY "package skills insert org"
    ON "public"."package_skills"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'packages.update'::"text"));

DROP POLICY IF EXISTS "package skills update org" ON "public"."package_skills";
CREATE POLICY "package skills update org"
    ON "public"."package_skills"
    FOR UPDATE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'packages.update'::"text"))
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'packages.update'::"text"));

DROP POLICY IF EXISTS "package skills delete org" ON "public"."package_skills";
CREATE POLICY "package skills delete org"
    ON "public"."package_skills"
    FOR DELETE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'packages.update'::"text"));

REVOKE ALL ON TABLE "public"."package_skills" FROM "anon";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."package_skills" TO "authenticated";
GRANT ALL ON TABLE "public"."package_skills" TO "service_role";
