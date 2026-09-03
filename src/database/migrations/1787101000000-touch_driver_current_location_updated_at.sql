-- public.driver_current_location.updated_at is timestamptz NOT NULL DEFAULT
-- now(), but nothing ever writes it after the first INSERT, so it records
-- "driver first seen", not "driver last seen".
--
-- The mobile app (hikyaku-mobile, ShiftActionsRepository.updateLocation)
-- upserts through PostgREST with
--
--   ?on_conflict=driver_id&columns=driver_id,location,speed
--
-- and `columns` is exactly the SET list PostgREST generates for the conflict
-- arm. The statement is therefore INSERT ... ON CONFLICT (driver_id) DO UPDATE
-- SET driver_id, location, speed -- updated_at is not in it, so the DO UPDATE
-- path leaves the column at whatever the original INSERT defaulted it to. The
-- column DEFAULT does not help: defaults apply to INSERT, never to UPDATE.
--
-- Confirmed on staging 2026-09-03 -- updated_at held at 10:42:06.367610 across
-- three subsequent position writes while pg_stat_user_tables.n_tup_upd for the
-- table kept incrementing, i.e. the rows were genuinely being updated and only
-- this column was standing still.
--
-- This table is in the supabase_realtime publication and backs the web
-- dashboard's live driver feed, so any consumer reading updated_at as "last
-- seen" sees a timestamp frozen at the moment the shift started: a moving
-- driver looks stale, and a genuinely stale driver is indistinguishable from a
-- fresh one.
--
-- Fixed in the database rather than in the mobile payload because the dashboard
-- and the API can also write this table; a client-side fix would have to be
-- repeated in each of them and would regress the moment a new writer appears.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION "public"."driver_current_location_touch"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    -- Unconditional, and deliberately overriding any updated_at the caller
    -- supplied. This column is a liveness heartbeat, not a change marker: a
    -- driver stopped at a light re-posts an identical location, and gating on
    -- `NEW.location IS DISTINCT FROM OLD.location` would make them decay to
    -- "stale" while they are in fact still reporting -- the same failure this
    -- migration exists to remove. Server clock only, so a client with a skewed
    -- or backdated clock cannot make itself look fresher than it is.
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."driver_current_location_touch"() IS
    'Sets driver_current_location.updated_at to now() on every UPDATE, including the ON CONFLICT DO UPDATE arm of the mobile app''s PostgREST upsert, which does not list the column. Makes updated_at usable as "driver last seen".';

DROP TRIGGER IF EXISTS "trg_driver_current_location_touch"
    ON "public"."driver_current_location";

-- BEFORE, so the value is stamped into the row itself and reaches both the
-- supabase_realtime WAL payload and the two existing AFTER triggers on this
-- table (trg_broadcast_driver_location, trg_log_driver_location_history).
CREATE TRIGGER "trg_driver_current_location_touch"
    BEFORE UPDATE ON "public"."driver_current_location"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."driver_current_location_touch"();
