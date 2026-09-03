-- Bug: starting a shift on mobile never wrote the driver's position. Every
-- upsert into public.driver_current_location (ShiftTrackingService ->
-- ShiftActionsRepository.updateLocation, and the same call on iOS/desktop)
-- failed with:
--
--   operator is not unique: extensions.geometry = extensions.geometry
--   SQLSTATE 42725
--
-- log_driver_location_history is an AFTER INSERT OR UPDATE trigger on that
-- table, so its failure aborted the whole statement: neither
-- driver_current_location nor driver_location_history ever got a row, and the
-- dashboard's live feed (driver_current_location is the only table in the
-- supabase_realtime publication) stayed empty.
--
-- Cause: the function pinned `SET search_path TO 'public'`. The geometry `=`
-- operator PostGIS installs lives in "extensions", which that search_path
-- excludes, so `NEW.location IS DISTINCT FROM OLD.location` could not resolve
-- to the one exact geometry/geometry operator and fell back to several
-- equally-good candidates reachable through implicit casts -- hence "not
-- unique" rather than "does not exist". PL/pgSQL plans an IF expression as a
-- whole, so this failed on INSERT too, even though the OLD comparison is
-- short-circuited away there. Its sibling trigger on the same table,
-- broadcast_driver_location_to_tracking, was unaffected: it lists "extensions"
-- in its own search_path and schema-qualifies extensions.st_x/st_y.
--
-- Fix: adopt the hardened `SET search_path = ''` convention (see
-- FixWarehouseTimezoneSrid1787100700000) and drop the geometry operator
-- entirely -- comparing the two EWKB encodings answers the same "has the point
-- actually moved" question using pg_catalog's bytea equality, which no
-- search_path can make ambiguous. Nothing else about the trigger changes.
--
-- The OLD reference also moves inside an explicit TG_OP = 'UPDATE' block.
-- PL/pgSQL plans each expression lazily on first execution, so on INSERT --
-- where OLD is unassigned -- that expression is now never reached at all,
-- rather than relying on OR short-circuiting to skip it.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION "public"."log_driver_location_history"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    -- An UPDATE that re-sends the same coordinates (a stationary driver still
    -- streaming fixes) is not a new breadcrumb.
    IF TG_OP = 'UPDATE'
       AND extensions.st_asewkb(NEW.location)
           IS NOT DISTINCT FROM extensions.st_asewkb(OLD.location)
    THEN
        RETURN NEW;
    END IF;

    INSERT INTO "public"."driver_location_history" (
        driver_id,
        location,
        created_at
    )
    VALUES (
        NEW.driver_id,
        NEW.location,
        now()
    );

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."log_driver_location_history"() IS
    'Appends a breadcrumb to driver_location_history whenever a driver''s live position is written, skipping UPDATEs that do not move the point.';
