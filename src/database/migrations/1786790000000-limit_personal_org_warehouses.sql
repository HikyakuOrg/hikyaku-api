-- A personal account gets exactly ONE warehouse. Company orgs stay unlimited.
--
-- Why a trigger and not a constraint:
--
--   A partial unique index -- `UNIQUE (organisation_id) WHERE <org is personal>`
--   -- is the obvious shape, and Postgres will not accept it. Index predicates
--   must be immutable and may only reference columns of the indexed row, and
--   "is this org personal?" lives one table over in organisations.org_type.
--   A CHECK constraint fails for the same reason. Denormalising org_type onto
--   warehouse would make the index legal but adds a column that has to be kept
--   in step with the org forever, for one rule.
--
--   So: a BEFORE trigger, which is the pattern this schema already uses for
--   cross-table invariants (enforce_same_warehouse, validate_driver_vehicle_warehouse).
--
-- This is the authoritative gate. The web app inserts into public.warehouse
-- straight through PostgREST (lib/supabase/db.ts createWarehouse), so anything
-- enforced only in the dashboard is enforced only against people using the
-- dashboard. The UI check in hikyaku/lib/warehouse-allowance.ts exists to keep
-- the user from reaching a form that cannot succeed -- not to enforce the rule.


CREATE OR REPLACE FUNCTION "public"."enforce_personal_org_warehouse_limit"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- SECURITY DEFINER for two reasons. It reads public.organisations, which the
    -- caller may not be able to SELECT under RLS, and -- more importantly -- it
    -- must count EVERY warehouse in the org, not just the rows the caller can
    -- see. A count filtered by the caller's own RLS view would let anyone whose
    -- visibility is narrower than the org sneak past the limit.
    SECURITY DEFINER
    SET search_path = ''
AS $$
DECLARE
    v_limit    constant integer := 1;
    v_org_type text;
    v_existing bigint;
BEGIN
    -- Lock the org row for the rest of the transaction. Without this the check
    -- is a classic read-then-write race: two concurrent inserts for the same
    -- personal org both count 0 (neither sees the other's uncommitted row) and
    -- both commit, leaving two warehouses behind. Serialising on the org row is
    -- what makes the count trustworthy.
    --
    -- FOR NO KEY UPDATE rather than FOR UPDATE: it blocks concurrent writes to
    -- the same org row but still allows FOR KEY SHARE, so other tables' foreign
    -- keys pointing at this org are not held up behind a warehouse insert.
    --
    -- Every warehouse insert pays this lock, including company orgs that skip
    -- the limit entirely. That is deliberate -- reading org_type unlocked first
    -- and only then locking would make the decision on a value that can change
    -- underneath us, and warehouse inserts are rare enough that a row lock on
    -- one organisations row costs nothing measurable.
    SELECT o.org_type
      INTO v_org_type
      FROM public.organisations o
     WHERE o.id = NEW.organisation_id
       FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        -- No such org. warehouse_organisation_id_fkey rejects this row a moment
        -- later with a better message than anything this function could raise.
        RETURN NEW;
    END IF;

    IF v_org_type IS DISTINCT FROM 'personal' THEN
        RETURN NEW;
    END IF;

    -- `id IS DISTINCT FROM NEW.id` excludes the row being moved on UPDATE. On
    -- INSERT it is a no-op: the default has already filled NEW.id by the time a
    -- BEFORE trigger runs, and the row itself is not in the table yet.
    SELECT count(*)
      INTO v_existing
      FROM public.warehouse w
     WHERE w.organisation_id = NEW.organisation_id
       AND w.id IS DISTINCT FROM NEW.id;

    IF v_existing >= v_limit THEN
        -- check_violation (23514) is deliberate: PostgREST maps it to HTTP 400
        -- and passes message/detail/hint through to the client, so the dashboard
        -- toast shows this sentence verbatim. A bare RAISE (P0001) would also
        -- reach the client, but 23514 says what this actually is -- an integrity
        -- constraint -- to anything reading the SQLSTATE rather than the prose.
        RAISE EXCEPTION
            'Personal accounts are limited to % warehouse. Create a company organisation to add more.',
            v_limit
            USING ERRCODE = 'check_violation',
                  DETAIL  = format('Organisation %s already has %s warehouse(s).',
                                   NEW.organisation_id, v_existing),
                  HINT    = 'Create a company organisation, or delete the existing warehouse first.';
    END IF;

    RETURN NEW;
END;
$$;

-- No explicit ALTER FUNCTION ... OWNER: the function is owned by whoever runs
-- the migration, which is the same role that owns these tables (DB_MIGRATION_URL
-- points at Supabase's direct connection as postgres). That matters here in a
-- way it does not for an ordinary function -- SECURITY DEFINER executes as the
-- owner, so the RLS-bypassing count above is only correct while the owner is
-- table-owning. An explicit OWNER TO postgres would state the intent but fail
-- outright for any migration role that is not a member of postgres, so this
-- follows AddOrganisationTrial and lets creation set it.

COMMENT ON FUNCTION "public"."enforce_personal_org_warehouse_limit"() IS
    'Caps personal organisations at one warehouse. Company orgs are unlimited. '
    'Runs BEFORE INSERT and BEFORE UPDATE OF organisation_id on public.warehouse; '
    'raises 23514 (check_violation) when the cap is reached.';


-- UPDATE OF organisation_id is covered, not just INSERT. The warehouse UPDATE
-- policies pass if the caller has warehouse.update on the target org OR owns it
-- as a personal org, so a user who administers a company org and also has their
-- own personal org can move a company warehouse across. Guarding INSERT alone
-- would leave that as the way in.
DROP TRIGGER IF EXISTS "warehouse_personal_org_limit" ON "public"."warehouse";

CREATE TRIGGER "warehouse_personal_org_limit"
    BEFORE INSERT OR UPDATE OF "organisation_id" ON "public"."warehouse"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_personal_org_warehouse_limit"();


-- Existing data -----------------------------------------------------------
-- Nothing is deleted or reassigned. The trigger gates new rows and org moves;
-- any personal org that is already over the cap keeps every warehouse it has and
-- simply cannot add another. Deleting a tenant's data to satisfy a limit
-- introduced after the fact is not a migration's call to make.
--
-- The notice below is so whoever runs this can see whether that case exists in
-- the target database rather than finding out from a support ticket.
DO $$
DECLARE
    v_over integer;
BEGIN
    SELECT count(*)
      INTO v_over
      FROM (
          SELECT w.organisation_id
            FROM public.warehouse w
            JOIN public.organisations o ON o.id = w.organisation_id
           WHERE o.org_type = 'personal'
           GROUP BY w.organisation_id
          HAVING count(*) > 1
      ) AS over_limit;

    IF v_over > 0 THEN
        RAISE NOTICE '% personal organisation(s) already hold more than one warehouse. These are grandfathered: existing rows are untouched, but no further warehouses can be added to them.', v_over;
    END IF;
END;
$$;


-- Out of scope ------------------------------------------------------------
-- org_type is still writable by tenants: ReserveInfraSlugs granted
-- UPDATE ("name", "org_type") on organisations to authenticated, so a personal
-- account can PATCH itself to 'company' and step around this cap in one request.
-- That is a pre-existing hole in the org grants -- the same one the trial
-- migration documents -- and closing it means narrowing that grant and giving
-- personal -> company upgrades a server-side path, which is a change to the
-- upgrade/billing flow, not to this constraint. Recording it here so the cap is
-- not mistaken for something it does not yet cover.
