--
-- Context: assigns drivers to drawn territories so a
-- package routes to whoever covers that address, instead of to whichever van is
-- cheapest to detour. Nothing in hikyaku-api reads service_areas yet; the web
-- dashboard writes it directly through PostgREST under RLS. The table is empty
-- (0 rows), so every change below is free to make now and would be expensive
-- later.
--
-- What ships here:
--   1. geometry widens from Polygon to MultiPolygon.
--   2. name goes from globally unique to unique per organisation.
--   3. created_at / updated_at / is_deleted, with the usual touch trigger.
--   4. a named SRID guard.
--   5. named validity, complexity, area and coordinate-extent guards.
--   6. get_service_area_extent and get_service_areas_in_bounds lose their
--      service_role grant and gain an is_deleted filter.
--
-- WARNING: COORDINATED DEPLOY REQUIRED (see section 1). Widening the column to
-- MultiPolygon breaks the dashboard's current INSERT/UPDATE path until the web
-- repo emits MULTIPOLYGON EWKT. Read section 1 before scheduling this.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Polygon → MultiPolygon ────────────────────────────────────────────────
--
-- Real territories are frequently disjoint: a suburb plus the island off it, or
-- one delivery zone cut in two by a river or a motorway with no crossing inside
-- it. A bare Polygon forces the dispatcher to create one *named* area per
-- disjoint piece, which then has to be kept in sync by hand and shows up as two
-- rows everywhere a territory should be one thing.
--
-- ST_Multi is a lossless promotion, not a repair: a Polygon becomes a
-- MultiPolygon with exactly one member and byte-identical rings. Containment is
-- unaffected. ST_Contains, ST_Covers and ST_Intersects are all defined over any
-- geometry type, and against a MultiPolygon they answer "inside any member",
-- which is exactly the coverage question a later ticket will ask. Nothing
-- downstream needs to change for the widening alone. (The one containment
-- subtlety, that ST_Contains is false for a point exactly on the boundary while
-- ST_Covers is true, is a pre-existing choice and is untouched by this.)
--
-- The GIST index idx_service_areas_geometry survives. ALTER COLUMN ... TYPE
-- rewrites the table and rebuilds every index on it, reparsing the original
-- index definition against the new type; a GIST index on a geometry column is
-- reparsed unchanged because gist_geometry_ops_2d applies to the whole geometry
-- type, not to a typmod. NOTE FOR REVIEW: this is documented PostgreSQL
-- behaviour, not something verified here. This migration was written without a
-- database connection, so nobody has run \d public.service_areas afterwards.
-- Confirm the index is present and valid on the dev/staging run before this
-- reaches production.
--
-- WARNING: BREAKING FOR THE WEB DASHBOARD, and it cannot be fixed from this side.
-- hikyaku/lib/maps/service-area-geometry.ts polygonFeatureToEwkt() emits
-- 'SRID=4326;POLYGON(...)', which both the add form and the edit page hand to
-- createServiceArea / updateServiceArea. PostGIS enforces the column's typmod
-- during the assignment cast, before any BEFORE trigger runs, so a plain
-- POLYGON will be rejected outright with:
--
--   Geometry type (Polygon) does not match column type (MultiPolygon)
--
-- and no trigger on this table can rescue it. The web fix is to emit
-- 'SRID=4326;MULTIPOLYGON((...))'. The dashboard's read path already copes:
-- normalizeServiceAreaGeometry, createServiceAreaFeatureCollection,
-- getServiceAreaFeatureCollectionBounds and isPointWithinServiceAreas all
-- branch on MultiPolygon already. Ship the web change with, or before, this
-- migration. (getEditableServiceAreaPolygonFeature does still reduce a
-- MultiPolygon to its largest member for editing, so editing a multi-part area
-- in the dashboard would silently drop the other lobes. That is a separate web
-- ticket, not a blocker for this one.)

ALTER TABLE "public"."service_areas"
    ALTER COLUMN "geometry" TYPE extensions.geometry(MultiPolygon, 4326)
    USING extensions.st_multi("geometry");

-- ── 2. name unique per organisation, not globally ────────────────────────────
--
-- service_area_name_key was UNIQUE (name) across the whole table, so the first
-- tenant to create "North Zone" or "City Centre" took the name away from every
-- other tenant on the platform, with a raw 23505 as the only feedback. That is
-- a straight multi-tenancy defect.
--
-- Kept case-sensitive, matching what the global constraint already did. The
-- schema does have one case-insensitive unique index (customer_org_phone_unique
-- on (organisation_id, lower(customer_phone))), but nothing anywhere uses
-- lower() on a *name* column, so there is no house pattern for names to follow
-- and inventing one here is out of scope. If "north zone" vs "North Zone"
-- collisions turn out to matter to dispatchers, that is a deliberate follow-up:
-- swap this index for one on (organisation_id, lower(name)).
--
-- Also deliberately NOT partial on is_deleted. That means a soft-deleted area
-- keeps its name reserved, so a dispatcher who retires "North Zone" cannot
-- immediately draw a new one by that name. The alternative, a partial index
-- WHERE is_deleted = false, lets the name be reused but then makes the
-- soft-deleted history ambiguous (two rows, same org, same name, only one
-- live). Neither is obviously right and nothing in the product exercises it
-- yet: there is no soft-delete affordance in the dashboard at all. Left as the
-- simpler of the two, to be revisited when the retire-an-area UI is designed.

ALTER TABLE "public"."service_areas"
    DROP CONSTRAINT IF EXISTS "service_area_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "service_areas_org_name_key"
    ON "public"."service_areas" ("organisation_id", "name");

-- ── 3. created_at / updated_at / is_deleted ──────────────────────────────────
--
-- The table carried no bookkeeping at all: no way to tell when a territory was
-- drawn, when it was last redrawn, or to retire one without destroying the
-- audit trail of which packages it used to cover.
--
-- is_deleted follows the vehicles convention exactly: the column exists, and
-- filtering it is the QUERY layer's job, not RLS's. See
-- src/dispatch/assignment.service.ts (loadCandidates, openShift) and
-- src/database/database.service.ts, which all spell out `AND v.is_deleted =
-- false` inline. The RLS SELECT policy stays as a pure tenancy predicate.
--
-- WARNING: EVERY READ ADDED BY A LATER TICKET IN THIS EPIC MUST FILTER
-- `is_deleted = false` EXPLICITLY. Nothing in the database will do it for you.
-- A coverage lookup that forgets it will happily route packages into a
-- territory the dispatcher retired months ago.
--
-- The DELETE policy is deliberately left in place. vehicles has both a live
-- "vehicles delete org" policy and an is_deleted column, so soft delete here is
-- something the application layer opts into, not something that requires taking
-- hard delete away.

ALTER TABLE "public"."service_areas"
    ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS "is_deleted" boolean NOT NULL DEFAULT false;

-- Mirrors vrp_optimization_touch (AddShiftLifecycleColumns1787100000000) down
-- to the naming: function and trigger share the table-prefixed name, plpgsql,
-- pinned empty search_path, BEFORE UPDATE FOR EACH ROW. now() needs no schema
-- qualification because pg_catalog is always searched regardless of
-- search_path; anything from PostGIS would, and there is none here.
CREATE OR REPLACE FUNCTION "public"."service_areas_touch"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    -- Unconditional, and server clock only. A dispatcher who reopens an area
    -- and saves the identical polygon has still touched it, and a client must
    -- not be able to backdate the column by supplying its own value.
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."service_areas_touch"() IS
    'Sets service_areas.updated_at to now() on every UPDATE, including the PostgREST writes the web dashboard makes, which do not list the column.';

DROP TRIGGER IF EXISTS "service_areas_touch" ON "public"."service_areas";

CREATE TRIGGER "service_areas_touch"
    BEFORE UPDATE ON "public"."service_areas"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."service_areas_touch"();

-- ── 4 & 5. Geometry guards ───────────────────────────────────────────────────
--
-- There is no API in front of this table. The web dispatcher drawing a polygon
-- talks to PostgREST directly, so a raw constraint-violation message is the
-- only feedback they will ever get. Every constraint below is therefore named
-- explicitly: "service_areas_geometry_srid_chk" at least tells the web layer
-- which message to map, where an auto-generated "service_areas_check1" tells
-- nobody anything.
--
-- srid_chk (F4)
--   The column typmod already says 4326, but typmod alone has burned this
--   codebase before. customer.customer_location is bare `extensions.geometry`
--   with no typmod at all, i.e. SRID 0, and later tickets will test those
--   points against these polygons. Mixing them raises:
--
--     Operation on mixed SRID geometries (MultiPolygon, 4326) != (Point, 0)
--
--   which is exactly the failure FixWarehouseTimezoneSrid1787100700000 already
--   fixed once for warehouse.warehouse_location against tzdata.timezone: a
--   column type promising 4326 is not the same thing as every value in it
--   actually carrying 4326. This check makes the promise enforceable.
--
--   WARNING: EVERY CONTAINMENT PREDICATE WRITTEN AGAINST THIS COLUMN MUST WRAP BOTH
--   SIDES IN ST_SetSRID(..., 4326), e.g.
--     extensions.st_covers(
--         extensions.st_setsrid(sa.geometry, 4326),
--         extensions.st_setsrid(c.customer_location, 4326))
--   This constraint guarantees the service_areas side. It cannot say anything
--   about the customer side, which is the side that is actually mislabelled.
--
-- valid_chk (F5)
--   Rejects self-intersecting rings, bow ties and rings that do not close: the
--   shapes a freehand draw tool produces when the dispatcher's cursor crosses
--   its own path. GEOS returns garbage rather than an error for these, so
--   without this check an invalid area silently under- or over-covers.
--
--   Deliberately NOT paired with an ST_MakeValid auto-repair trigger. Repair on
--   an invalid polygon can split it, drop a lobe or invert a hole, and it would
--   do so silently, after the dispatcher clicked save on something else. A
--   rejection they can see and redraw beats a territory that quietly is not the
--   one they drew.
--
-- complexity_chk (F5): 10000 vertices
--   Sized to be roughly two orders of magnitude above anything legitimate, so
--   it only ever fires on genuinely pathological input:
--     - a hand-drawn territory is tens of vertices;
--     - an uploaded administrative boundary (the add form accepts a GeoJSON
--       file) is hundreds to low thousands at normal simplification;
--     - a raw GPS trace of someone driving the boundary, or an unsimplified
--       coastline, is tens to hundreds of thousands. That is the input this
--       rejects.
--   The ceiling matters because of what reads this column. At 10000 vertices a
--   row holds roughly 160 KB of coordinates, well past the TOAST threshold, so
--   it is stored out of line and detoasted on every containment test; and the
--   GIST index only ever prunes by bounding box, so the exact ST_Covers recheck
--   pays that cost per candidate row. A per-package coverage lookup on the
--   assignment hot path stays comfortable at this bound and would not at 10x.
--   ST_NPoints (not ST_NumPoints, which is LineString-only) counts every vertex
--   of every ring of every member, which is the right total-cost measure for a
--   MultiPolygon.
--
-- area_chk (F5)
--   ST_Area > 0 rejects the degenerate cases ST_IsValid does not reliably
--   catch: MULTIPOLYGON EMPTY (valid, zero vertices) and collinear zero-area
--   rings. Area is in square degrees here, which is meaningless as a magnitude
--   but perfectly good for "> 0"; a genuine single-building territory is still
--   many orders of magnitude above zero, so this cannot reject real input.
--
-- extent_chk (F5)
--   The lon/lat swap. A dispatcher's polygon in Singapore is around
--   (103.8, 1.35); swapped it becomes (1.35, 103.8), which is a perfectly valid
--   non-self-intersecting polygon of the right size and shape sitting in the
--   Arctic Ocean, and nothing else in the stack would catch it. Latitude 103.8
--   does not exist, so a bounds check catches the whole class for any longitude
--   outside +/-90, which is most inhabited longitudes. It also catches
--   coordinates handed over in Web Mercator metres (a client that forgot to
--   reproject) and polygons drawn across a wrapped world copy in MapLibre,
--   where longitudes come out as 200 or 540 rather than being normalised back
--   into +/-180. All three are client bugs that should be fixed in the client,
--   not accommodated here.
--
--   The bbox is read from the geometry header rather than recomputed, so this
--   is O(1) per row regardless of vertex count. The cast to box3d is written
--   out rather than left to the implicit geometry -> box3d cast, so the stored
--   constraint expression is unambiguous to anyone reading it back.
--
-- All five go on with NOT VALID then VALIDATE, the house pattern from
-- AddShiftLifecycleColumns1787100000000: the ADD takes a brief ACCESS EXCLUSIVE
-- lock without scanning, and the scan afterwards runs under SHARE UPDATE
-- EXCLUSIVE. On an empty table both are instant. If VALIDATE does fail, some
-- environment has rows this migration was told did not exist, and stopping is
-- the correct outcome.
--
-- The pg_constraint guards are what make this file safely re-runnable by hand:
-- ADD CONSTRAINT has no IF NOT EXISTS.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.service_areas'::regclass
           AND conname  = 'service_areas_geometry_srid_chk'
    ) THEN
        ALTER TABLE "public"."service_areas"
            ADD CONSTRAINT "service_areas_geometry_srid_chk"
            CHECK (extensions.st_srid("geometry") = 4326)
            NOT VALID;
        ALTER TABLE "public"."service_areas"
            VALIDATE CONSTRAINT "service_areas_geometry_srid_chk";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.service_areas'::regclass
           AND conname  = 'service_areas_geometry_valid_chk'
    ) THEN
        ALTER TABLE "public"."service_areas"
            ADD CONSTRAINT "service_areas_geometry_valid_chk"
            CHECK (extensions.st_isvalid("geometry"))
            NOT VALID;
        ALTER TABLE "public"."service_areas"
            VALIDATE CONSTRAINT "service_areas_geometry_valid_chk";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.service_areas'::regclass
           AND conname  = 'service_areas_geometry_complexity_chk'
    ) THEN
        ALTER TABLE "public"."service_areas"
            ADD CONSTRAINT "service_areas_geometry_complexity_chk"
            CHECK (extensions.st_npoints("geometry") <= 10000)
            NOT VALID;
        ALTER TABLE "public"."service_areas"
            VALIDATE CONSTRAINT "service_areas_geometry_complexity_chk";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.service_areas'::regclass
           AND conname  = 'service_areas_geometry_area_chk'
    ) THEN
        ALTER TABLE "public"."service_areas"
            ADD CONSTRAINT "service_areas_geometry_area_chk"
            CHECK (extensions.st_area("geometry") > 0)
            NOT VALID;
        ALTER TABLE "public"."service_areas"
            VALIDATE CONSTRAINT "service_areas_geometry_area_chk";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.service_areas'::regclass
           AND conname  = 'service_areas_geometry_extent_chk'
    ) THEN
        ALTER TABLE "public"."service_areas"
            ADD CONSTRAINT "service_areas_geometry_extent_chk"
            CHECK (
                    extensions.st_xmin("geometry"::extensions.box3d) >= -180
                AND extensions.st_xmax("geometry"::extensions.box3d) <=  180
                AND extensions.st_ymin("geometry"::extensions.box3d) >=  -90
                AND extensions.st_ymax("geometry"::extensions.box3d) <=   90
            )
            NOT VALID;
        ALTER TABLE "public"."service_areas"
            VALIDATE CONSTRAINT "service_areas_geometry_extent_chk";
    END IF;
END;
$$;

COMMENT ON COLUMN "public"."service_areas"."geometry" IS
    'Delivery territory, geometry(MultiPolygon,4326). Multi-part so one named area can cover disjoint pieces. Guarded by service_areas_geometry_{srid,valid,complexity,area,extent}_chk. Containment predicates must wrap BOTH sides in ST_SetSRID(...,4326): customer.customer_location is bare geometry (SRID 0).';

COMMENT ON COLUMN "public"."service_areas"."is_deleted" IS
    'Soft delete. Filtered in the query layer, never in RLS, matching vehicles.is_deleted. Every read must spell out `AND is_deleted = false`.';

-- ── 6. Tenant-scope the two read RPCs ────────────────────────────────────────
--
-- Both functions select from public.service_areas with no organisation
-- predicate, relying entirely on the table's RLS SELECT policy
-- (is_org_member(organisation_id)) for tenancy. That is correct, and only
-- correct, for a caller whose role is subject to RLS.
--
-- service_role is not. It carries BYPASSRLS, and hikyaku-api connects as
-- service_role over its TypeORM DataSource, so any server-side call of either
-- function today returns every tenant's territories in one result set. Nothing
-- calls them from here yet (hikyaku-api has zero references to service_area
-- anywhere in src/), so this is a latent trap rather than a live leak, and the
-- cheapest time to close it is before the epic's later tickets add the first
-- server-side caller.
--
-- Fix: take the grant away rather than bolt an organisation parameter on. The
-- signatures do not change at all, so the web dashboard
-- (hikyaku/lib/supabase/db-server.ts getServiceAreaExtent, and
-- getServiceAreasInBounds) keeps working untouched: it goes through
-- lib/supabase/server.ts, which builds a request-scoped client on the
-- publishable/anon key plus the user's cookie, so it executes as
-- `authenticated` and RLS scopes it correctly. Confirmed by grep across both
-- repos that these are the only two callers of either function.
--
-- REVOKE FROM service_role alone would not be enough. PostgreSQL grants EXECUTE
-- on every new function to PUBLIC, and Supabase additionally carries
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
-- FUNCTIONS TO service_role` (infra/db/schema.sql), which re-applies
-- itself to anything created here. So each function is stripped back to PUBLIC
-- and the three Supabase roles, then granted forward to `authenticated` only.
--
-- WARNING: FOR WHOEVER ADDS THE SERVER-SIDE COVERAGE LOOKUP: do not re-grant these to
-- service_role to make your query work. They are org-unscoped by construction,
-- and under service_role they answer across the whole platform. Write a query
-- that filters organisation_id explicitly instead.
--
-- get_service_areas_in_bounds gains organisation_id in its result. It is
-- appended last so it is purely additive: PostgREST hands the dashboard objects
-- rather than tuples, and no consumer reads these positionally. The web repo's
-- generated hikyaku/lib/supabase/supabase.ts goes stale on both this and the
-- three new table columns, but stale in the harmless direction (an untyped
-- extra field, and inserts that still satisfy every NOT NULL because all three
-- have defaults). Regenerating it is a web follow-up, not a blocker.
--
-- Note the asymmetry below. get_service_area_extent keeps its column list, so
-- CREATE OR REPLACE is enough and its existing ACL survives, which is exactly
-- why it needs the explicit REVOKEs. get_service_areas_in_bounds changes its
-- RETURNS TABLE, and a changed OUT-parameter row type cannot be replaced in
-- place ("cannot change return type of existing function"), so it has to be
-- dropped and recreated. Both are written out below regardless of which
-- mechanism strictly needs them.
--
-- search_path stays 'public', 'extensions' on both, unchanged. Do not "harden"
-- these to search_path = '' without also rewriting the operators:
-- FixDriverLocationHistorySearchPath1787100900000 documents what happens when a
-- geometry operator loses sight of the extensions schema, and the `&&` bbox
-- operator below is precisely such an operator. Neither function is SECURITY
-- DEFINER, so it executes with the caller's own rights and there is nothing for
-- a hostile search_path to escalate to.

CREATE OR REPLACE FUNCTION "public"."get_service_area_extent"() RETURNS TABLE("min_lng" double precision, "min_lat" double precision, "max_lng" double precision, "max_lat" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
    SELECT
        ST_XMin(extent) AS min_lng,
        ST_YMin(extent) AS min_lat,
        ST_XMax(extent) AS max_lng,
        ST_YMax(extent) AS max_lat
    FROM (
        SELECT ST_Extent(geometry)::extensions.box2d AS extent
        FROM public.service_areas
        WHERE is_deleted = false
    ) AS service_area_extent
    WHERE extent IS NOT NULL;
$$;

COMMENT ON FUNCTION "public"."get_service_area_extent"() IS
    'Bounding box of the caller organisation''s live service areas, for the dashboard map''s initial fit. Org scoping comes entirely from the RLS SELECT policy on service_areas, so this is granted to authenticated ONLY: service_role is deliberately not granted, because it bypasses RLS and would get every tenant''s extent. Any future server-side caller must use an explicitly org-scoped query instead of this function.';

REVOKE ALL ON FUNCTION "public"."get_service_area_extent"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_service_area_extent"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_service_area_extent"() FROM "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_service_area_extent"() TO "authenticated";

DROP FUNCTION IF EXISTS "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision);

CREATE FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) RETURNS TABLE("id" "uuid", "name" "text", "geometry" json, "organisation_id" "uuid")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
    -- Every column reference stays qualified with sa. RETURNS TABLE puts id,
    -- name, geometry and organisation_id in scope as OUT parameters, and a bare
    -- reference to any of them is an ambiguity error rather than a column read.
    SELECT
        sa.id,
        sa.name,
        ST_AsGeoJSON(sa.geometry)::json AS geometry,
        sa.organisation_id
    FROM public.service_areas AS sa
    WHERE sa.is_deleted = false
      AND sa.geometry && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
      AND ST_Intersects(sa.geometry, ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326))
    ORDER BY sa.name ASC;
$$;

COMMENT ON FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) IS
    'Live service areas of the caller''s organisation intersecting a viewport, as GeoJSON. Org scoping comes entirely from the RLS SELECT policy on service_areas, so this is granted to authenticated ONLY: service_role is deliberately not granted, because it bypasses RLS and would return every tenant''s areas. Any future server-side caller must use an explicitly org-scoped query instead of this function.';

REVOKE ALL ON FUNCTION "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision) FROM "anon";
REVOKE ALL ON FUNCTION "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision) FROM "service_role";
GRANT EXECUTE ON FUNCTION "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision) TO "authenticated";
