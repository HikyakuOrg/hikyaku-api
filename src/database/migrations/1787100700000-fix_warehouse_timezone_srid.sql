-- Bug: creating a warehouse (mobile AddWarehouseScreen, or the web dashboard's
-- own insert into public.warehouse -- both go through the same trigger) could
-- fail with:
--
--   Operation on mixed SRID geometries (MultiPolygon, 0) != (Point, 4326)
--
-- This comes from warehouse_set_timezone (AssignmentBookkeeping1787100300000),
-- which point-in-polygon tests the new warehouse_location against every row
-- of tzdata.timezone. It already relabels NEW.warehouse_location as SRID
-- 4326 before comparing, but trusted tz.geom's stored SRID as-is, relying on
-- its column type -- geometry(MultiPolygon,4326) -- to guarantee it. At least
-- some rows do not carry that SRID at read time (most likely: ogr2ogr's
-- background import writes tz.geom via plain INSERT against a column in the
-- non-default "extensions" schema, and when its SRID introspection cannot
-- resolve that, it falls back to tagging the EWKB it sends as SRID 0 --
-- the coordinates are still correct WGS84 degrees, courtesy of -t_srs
-- EPSG:4326, just mistagged). Any warehouse whose point happened to fall
-- inside one of those rows' polygon could never be created.
--
-- Fix: relabel tz.geom to 4326 the same way NEW.warehouse_location already
-- is. This is a relabel, not a reprojection -- safe because the underlying
-- numbers are already WGS84 degrees, only the SRID tag is wrong.

CREATE OR REPLACE FUNCTION "public"."set_warehouse_timezone"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- SECURITY DEFINER: tzdata.timezone is not readable by PostgREST's
    -- authenticated role, and a dispatcher moving a warehouse pin must not have
    -- to be.
    SECURITY DEFINER
    SET search_path = ''
AS $$
DECLARE
    v_tzid text;
BEGIN
    SELECT tz.tzid
      INTO v_tzid
      FROM tzdata.timezone tz
     WHERE extensions.st_within(
               extensions.st_setsrid(NEW.warehouse_location, 4326),
               extensions.st_setsrid(tz.geom, 4326)
           )
     LIMIT 1;

    -- UTC rather than an error: a warehouse in the ocean, or a tzdata table that
    -- has not been imported yet, must not block creating the warehouse.
    NEW.timezone := COALESCE(v_tzid, 'UTC');
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."set_warehouse_timezone"() IS
    'Resolves warehouse.timezone from tzdata.timezone by point-in-polygon whenever warehouse_location is written. Both sides are relabelled to SRID 4326 before comparing -- some tzdata.timezone rows carry SRID 0 despite the column''s geometry(MultiPolygon,4326) type, which otherwise raises "mixed SRID geometries" and blocks the warehouse insert entirely.';
