-- Bug: a position fix that carries no speed was silently dropped. The mobile
-- app (hikyaku-mobile, ShiftActionsRepository.updateLocation) upserts into
-- public.driver_current_location through PostgREST, and the write failed with:
--
--   null value in column "speed" violates not-null constraint
--   SQLSTATE 23502
--
-- Chain: LocationProvider reports `speed = if (location.hasSpeed()) ... else
-- null` -- null on a first fix, indoors, and routinely on iOS. supabase-kt
-- serializes with Json.Default, i.e. encodeDefaults = false, and the payload
-- DTO declared `speed: Double? = null`, so a null speed equals the declared
-- default and the key is omitted from the JSON entirely. PostgREST derives its
-- column list from the body's keys, so the request became
--
--   ?on_conflict=driver_id&columns=driver_id,location
--
-- and the INSERT arm supplied no speed at all. The column was numeric NOT NULL
-- with no DEFAULT, so the statement aborted. Neither driver_current_location
-- nor driver_location_history got a row, and the dashboard's live feed stayed
-- empty for that fix. Never seen in testing because Lockito always reports a
-- speed.
--
-- Fix: make the column nullable. NULL is what actually happened -- the platform
-- did not report a speed -- and it is what the client type already says
-- (DeviceLocation.speed is `Double?`, documented as "metres/second when the
-- platform reports it").
--
-- Deliberately NOT `SET DEFAULT 0`:
--
--   * It asserts "stationary" for a reading that is merely unknown. A driver
--     parked at a depot and a driver whose GPS has not yet resolved a doppler
--     fix are not the same fact, and once written as 0 they are
--     indistinguishable.
--   * It does not even fix this bug on the UPDATE path. Column DEFAULTs apply
--     to INSERT, never to UPDATE, and `speed` is absent from the SET list that
--     PostgREST generates for the ON CONFLICT DO UPDATE arm. The first fix of a
--     shift would insert 0 and every later speed-less fix would leave whatever
--     speed was last written standing -- so a driver who was doing 25 m/s and
--     then loses speed reporting reads as 25 m/s indefinitely, on a table whose
--     entire purpose is a live feed. That is the same frozen-column failure
--     that trg_driver_current_location_touch exists to remove for updated_at.
--
-- The staleness half is fixed on the client, in the same change: the DTO now
-- declares `speed` without a default, so the key is always encoded (null
-- included) and `speed` is always in PostgREST's column list -- meaning the
-- DO UPDATE arm now writes it every time, to NULL when the platform is silent.
-- Both halves are needed: this migration alone stops the write failing but
-- would let a stale speed persist; the client change alone would still hit the
-- not-null constraint.
--
-- Safe to widen: nothing reads this column. `speed` appears exactly once in the
-- whole schema -- this definition -- with no view, index, constraint or policy
-- depending on it. The web dashboard selects it once
-- (lib/supabase/db-server.ts getDriverCurrentLocation) and discards it,
-- returning coordinates only; its client-side twin and the realtime consumer in
-- components/route-map.tsx do not select it at all; the "Average speed" tile on
-- the team-member page is derived from distanceKm / elapsedHours over
-- driver_location_history, which has no speed column. hikyaku-api never reads
-- it. Regenerate the dashboard's Supabase types after this lands: speed becomes
-- `number | null`.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "public"."driver_current_location"
    ALTER COLUMN "speed" DROP NOT NULL;

COMMENT ON COLUMN "public"."driver_current_location"."speed" IS
    'Ground speed in metres per second as reported by the device, or NULL when the platform reported no speed for the fix (first fix, indoors, and commonly on iOS). NULL means unknown, not stationary -- a stopped driver reports 0.';
