--
-- Context: which drivers cover a delivery point? service_areas already holds the
-- territories a dispatcher draws (see FixServiceAreaSchema1788656400000, which
-- widened them to MultiPolygon and added the soft-delete and geometry guards).
-- What is still missing is the link between a driver and the territories they
-- cover, which is the join every coverage question in this epic has to go
-- through.
--
-- What ships here:
--   1. drivers and service_areas each gain a UNIQUE (id, organisation_id), so a
--      composite foreign key can reference them. Nothing else uses these.
--   2. the driver_service_area link table itself, with composite FKs that make a
--      cross-tenant pairing structurally impossible.
--   3. indexes for the two directions the coverage query walks.
--   4. RLS mirroring service_areas: is_org_member to read, the existing
--      service_areas.edit permission to write.
--
-- Nothing calls this yet. The web dashboard will write it directly through
-- PostgREST, exactly as it writes service_areas; hikyaku-api only ever reads it,
-- through src/dispatch/coverage.ts.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY COMPOSITE FOREIGN KEYS AND NOT A same_org() FUNCTION IN THE RLS POLICY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This repo already answers "stop a cross-tenant pairing" once, in
-- driver_vehicle_assignment, and that answer was read carefully before this one
-- was written. It has no organisation_id column at all. Instead its INSERT and
-- UPDATE policies call:
--
--     WITH CHECK (has_permission_for_driver(driver_id, 'drivers.update')
--                 AND driver_vehicle_same_org(driver_id, vehicle_id))
--
-- where driver_vehicle_same_org is a STABLE SECURITY DEFINER function that looks
-- up both parents' real organisation_id and compares them. That design is sound
-- on its own terms, and notably it is already immune to a client supplying a
-- forged organisation_id, because there is no such column to forge.
--
-- Two things make it the wrong fit here.
--
-- FIRST, this table needs an organisation_id column and that one does not. The
-- policy shape this ticket has to mirror is service_areas': is_org_member(
-- organisation_id) to read and has_org_permission(organisation_id,
-- 'service_areas.edit') to write. Both take an organisation id as an argument,
-- so the column has to exist. The moment it exists it is client-supplied, and a
-- same_org(driver, area) function does NOT constrain it: a member of org B
-- holding service_areas.edit in their own org could insert
-- (driver_id = one of org A's drivers, service_area_id = one of org A's areas,
-- organisation_id = B). The function passes, because A's driver and A's area
-- genuinely are in the same org as each other. has_org_permission(B, ...) passes,
-- because the writer really does hold that permission in B. The row lands, and
-- because the SELECT policy is is_org_member(organisation_id), every member of
-- org B can now read a row naming org A's driver and org A's territory.
-- Defending that with a function means a three-argument
-- same_org(driver, area, org) that re-derives both parents and compares each to
-- the supplied column, which is a hand-written re-implementation of what a
-- composite foreign key does declaratively.
--
-- SECOND, RLS is not a general integrity mechanism, it is a per-role one.
-- driver_vehicle_assignment's check does not apply to service_role, which
-- carries BYPASSRLS and is the role hikyaku-api connects as. That gap is
-- harmless there in practice, because nothing writes that table as service_role.
-- It is a worse bet here: this epic's whole direction of travel is server-side
-- coverage logic, and a later ticket adding a service-role write path (a bulk
-- import, a backfill, an admin repair script) would silently lose the check with
-- no error and no reviewer prompt. A foreign key cannot be bypassed by any role.
--
-- So: composite FKs. The cost is honest and worth naming. It needs a redundant
-- UNIQUE (id, organisation_id) on each parent, purely so the FK has something to
-- reference, and it means drivers.organisation_id and service_areas
-- .organisation_id can no longer be changed while coverage rows point at them.
-- Both are acceptable. drivers already carries a redundant drivers_id_key
-- UNIQUE (id) alongside its primary key, so an extra unique index on that table
-- is not a new kind of thing, and moving a driver or a territory between
-- organisations is not an operation the product supports. The FK raising rather
-- than silently orphaning coverage is the outcome to want there.
--
-- What this deliberately does NOT do is copy driver_vehicle_assignment's
-- policies. has_permission_for_driver is driver-scoped and would let anyone with
-- drivers.update edit territory coverage; the permission that governs
-- territories is service_areas.edit, and it is reused rather than a new one
-- minted.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Parent unique constraints ─────────────────────────────────────────────
--
-- A composite FK must reference a unique constraint covering exactly its
-- referenced columns. (id) alone being unique is not enough for PostgreSQL to
-- accept (id, organisation_id) as a target, even though it logically implies it.
-- These two constraints exist only to be referenced and should never be used as
-- lookup keys.
--
-- UNIQUE does not support NOT VALID (only CHECK and FOREIGN KEY do), so unlike
-- the geometry guards in FixServiceAreaSchema1788656400000 these cannot be added
-- unvalidated and scanned afterwards: each one builds its index under ACCESS
-- EXCLUSIVE. That is bounded here by lock_timeout above and by the tables being
-- small (drivers is one row per person employed; service_areas is one row per
-- territory drawn by hand, and was empty as of the previous migration). If this
-- ever times out on a large deployment, the escape hatch is CREATE UNIQUE INDEX
-- CONCURRENTLY outside a transaction followed by ADD CONSTRAINT ... USING INDEX,
-- which cannot be expressed in a TypeORM migration because those run in one.
--
-- The pg_constraint guards make the file re-runnable by hand: ADD CONSTRAINT has
-- no IF NOT EXISTS.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.drivers'::regclass
           AND conname  = 'drivers_id_organisation_id_key'
    ) THEN
        ALTER TABLE "public"."drivers"
            ADD CONSTRAINT "drivers_id_organisation_id_key"
            UNIQUE ("id", "organisation_id");
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.service_areas'::regclass
           AND conname  = 'service_areas_id_organisation_id_key'
    ) THEN
        ALTER TABLE "public"."service_areas"
            ADD CONSTRAINT "service_areas_id_organisation_id_key"
            UNIQUE ("id", "organisation_id");
    END IF;
END;
$$;

COMMENT ON CONSTRAINT "drivers_id_organisation_id_key" ON "public"."drivers" IS
    'Exists only so driver_service_area can reference (id, organisation_id) with a composite foreign key, which is what makes a cross-tenant coverage row impossible for every role including service_role. Not a lookup key. Dropping it breaks that FK.';

COMMENT ON CONSTRAINT "service_areas_id_organisation_id_key" ON "public"."service_areas" IS
    'Exists only so driver_service_area can reference (id, organisation_id) with a composite foreign key, which is what makes a cross-tenant coverage row impossible for every role including service_role. Not a lookup key. Dropping it breaks that FK.';

-- ── 2. The link table ────────────────────────────────────────────────────────
--
-- Many-to-many on purpose, in both directions. One driver covers several
-- territories, and OVERLAPPING TERRITORIES ARE A LEGITIMATE CONFIGURATION, not
-- an error: two drivers sharing a dense city centre while each also owns a
-- suburb is the normal way a dispatcher draws a metro. There is deliberately no
-- constraint anywhere here forbidding two drivers from covering the same area,
-- or one point from falling inside two areas. A coverage lookup returning two
-- drivers for one address is the expected answer, and the assignment engine
-- picks between them on cost, exactly as it does today.
--
-- The composite FKs carry the whole cross-tenant guarantee (see the header). Each
-- one also subsumes the plain single-column reference, so there is no separate
-- FK to drivers(id) or service_areas(id): (driver_id, organisation_id) already
-- guarantees driver_id names a real driver.
--
-- The constraints are declared inline rather than added NOT VALID and validated
-- afterwards, because CREATE TABLE produces an empty table in the same statement
-- and there is nothing for a validation scan to find.
--
-- WARNING: ON DELETE CASCADE ON BOTH SIDES IS DELIBERATE AND LOSES HISTORY
-- SILENTLY. Deleting a driver, or hard-deleting a service area, drops that
-- pairing with no trace: no tombstone, no audit row, nothing for a dispatcher to
-- notice. That is the right default for a pure join table (a dangling coverage
-- row pointing at a deleted driver is worse than no row), but it sits awkwardly
-- beside the soft delete the previous migration gave service_areas. Retiring a
-- territory the soft way sets is_deleted = true and KEEPS these rows, which is
-- what lets a dispatcher un-retire it and get the same drivers back; deleting it
-- the hard way, which the DELETE policy below still permits, destroys them. If
-- drivers ever gains its own is_deleted the same split appears on that side too.
-- Resolving that tension (probably: take hard delete away once the retire-a-
-- territory UI exists) is deliberately out of scope here, but a future reader
-- hitting "where did this driver's coverage go" should start at this comment.
--
-- organisation_id gets its own FK to organisations as well. It is redundant with
-- the composite FKs, which already reach organisations transitively through
-- drivers and service_areas, and it is kept because it makes the ON DELETE
-- CASCADE from a deleted organisation direct rather than dependent on the order
-- two other cascades happen to fire in.

CREATE TABLE IF NOT EXISTS "public"."driver_service_area" (
    "driver_id"       "uuid"      NOT NULL,
    "service_area_id" "uuid"      NOT NULL,
    "organisation_id" "uuid"      NOT NULL,
    "created_at"      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "driver_service_area_pkey"
        PRIMARY KEY ("driver_id", "service_area_id"),

    CONSTRAINT "driver_service_area_driver_org_fkey"
        FOREIGN KEY ("driver_id", "organisation_id")
        REFERENCES "public"."drivers" ("id", "organisation_id")
        ON DELETE CASCADE,

    CONSTRAINT "driver_service_area_area_org_fkey"
        FOREIGN KEY ("service_area_id", "organisation_id")
        REFERENCES "public"."service_areas" ("id", "organisation_id")
        ON DELETE CASCADE,

    CONSTRAINT "driver_service_area_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE
);

ALTER TABLE "public"."driver_service_area" OWNER TO "postgres";

COMMENT ON TABLE "public"."driver_service_area" IS
    'Which delivery territories each driver covers. Many-to-many, and overlap is legitimate: a point inside two areas covered by two drivers returns both. A driver with NO rows here is a "floater" and is treated as covering everywhere, which is what keeps an empty table behaving exactly like the pre-service-area engine. See src/dispatch/coverage.ts.';

COMMENT ON COLUMN "public"."driver_service_area"."organisation_id" IS
    'The organisation both parents belong to. Not client-trusted: the composite foreign keys to drivers(id, organisation_id) and service_areas(id, organisation_id) make a value that disagrees with either parent impossible to insert, for every role including service_role.';

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
--
-- The primary key (driver_id, service_area_id) already serves the forward
-- direction ("which areas does this driver cover?") and the floater probe
-- (NOT EXISTS ... WHERE driver_id = d.id), both of which only need the leading
-- column. It also serves the cascade scan when a driver is deleted.
--
-- The reverse direction needs its own index. Note it leads with service_area_id
-- and carries driver_id, rather than being on service_area_id alone: the batch
-- coverage query resolves the covering service_area_ids first and then wants
-- only the driver ids attached to them, so the extra column turns that into an
-- index-only scan with no heap fetch. It is a strict superset of the plain
-- (service_area_id) index for every other purpose, including the cascade scan
-- when a service area is hard-deleted.
--
-- organisation_id is indexed to match service_areas_organisation_id_idx and to
-- keep the organisation-delete cascade off a sequential scan.

CREATE INDEX IF NOT EXISTS "driver_service_area_area_driver_idx"
    ON "public"."driver_service_area" ("service_area_id", "driver_id");

CREATE INDEX IF NOT EXISTS "driver_service_area_organisation_id_idx"
    ON "public"."driver_service_area" ("organisation_id");

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
--
-- Mirrors service_areas exactly: any member of the organisation may read who
-- covers what, and editing coverage needs the same service_areas.edit permission
-- as drawing the territory itself. That permission is REUSED, not extended, and
-- no new app_permission row is minted: assigning a driver to a territory and
-- redrawing that territory are the same job, done by the same person, and
-- splitting them would mean a dispatcher who can draw an area but not staff it.
--
-- All four policies are TO authenticated. service_role is not mentioned because
-- it bypasses RLS entirely; the header explains why that is exactly why the
-- cross-tenant guarantee lives in the foreign keys instead of in a WITH CHECK.
--
-- DROP then CREATE because PostgreSQL has no CREATE POLICY IF NOT EXISTS, and
-- this file has to survive being re-run by hand.

ALTER TABLE "public"."driver_service_area" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "driver service area select org members" ON "public"."driver_service_area";
CREATE POLICY "driver service area select org members"
    ON "public"."driver_service_area"
    FOR SELECT TO "authenticated"
    USING ("public"."is_org_member"("organisation_id"));

DROP POLICY IF EXISTS "driver service area insert org" ON "public"."driver_service_area";
CREATE POLICY "driver service area insert org"
    ON "public"."driver_service_area"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"));

DROP POLICY IF EXISTS "driver service area update org" ON "public"."driver_service_area";
CREATE POLICY "driver service area update org"
    ON "public"."driver_service_area"
    FOR UPDATE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"))
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"));

DROP POLICY IF EXISTS "driver service area delete org" ON "public"."driver_service_area";
CREATE POLICY "driver service area delete org"
    ON "public"."driver_service_area"
    FOR DELETE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"));

-- ── 5. Grants ────────────────────────────────────────────────────────────────
--
-- Supabase carries `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
-- GRANT ALL ON TABLES TO anon` (infra/db/schema.sql), so this table arrives with
-- an anon grant whether or not anyone asked for one. It is revoked here. There
-- is no anon policy on this table and there is never going to be one: coverage
-- is dispatcher configuration, and the booking site has no business reading
-- which driver covers which street. service_areas still carries its inherited
-- anon grant, which is dead weight rather than a live hole (its policies are all
-- TO authenticated too), and tidying that is a separate change; this table
-- simply does not acquire the same debt.
--
-- service_role keeps its grant, unlike the two read RPCs in
-- FixServiceAreaSchema1788656400000. Those were revoked because they were
-- org-unscoped by construction and would answer across the whole platform under
-- a role that bypasses RLS. A plain table is not: every server-side read of it
-- goes through src/dispatch/coverage.ts, which filters organisation_id
-- explicitly in SQL.

REVOKE ALL ON TABLE "public"."driver_service_area" FROM "anon";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."driver_service_area" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_service_area" TO "service_role";
