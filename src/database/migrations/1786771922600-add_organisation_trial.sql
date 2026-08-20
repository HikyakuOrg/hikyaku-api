-- A company organisation gets a 7-day trial the moment it is created. The clock
-- is stored as an absolute deadline (`trial_ends_at`) rather than a start date
-- plus a duration, so changing the trial length later cannot retroactively move
-- an existing org's deadline.
--
-- Three rules define the column, and everything downstream (the API guard, the
-- dashboard dialog, the sidebar countdown) reads them off this one value:
--
--   NULL            no trial applies — the org is unrestricted.
--   > now()         trial running.
--   <= now()        trial over.
--
-- NULL meaning "unrestricted" rather than "expired" is what makes this migration
-- safe to deploy: personal orgs and every org that already exists keep working
-- untouched. See the backfill note at the bottom.


-- Column -----------------------------------------------------------------
-- Nullable with no DEFAULT. A DEFAULT cannot branch on org_type, and the value
-- has to be NULL for personal orgs, so the trigger below is the only writer on
-- the insert path.
ALTER TABLE "public"."organisations"
    ADD COLUMN "trial_ends_at" timestamptz;

COMMENT ON COLUMN "public"."organisations"."trial_ends_at" IS
    'Absolute end of the 7-day company trial. NULL = no trial applies (personal '
    'orgs, and every org created before this column existed). Set by '
    'set_organisation_trial() on INSERT and not writable by tenants.';


-- Insert trigger ---------------------------------------------------------
-- Server-side authority over the deadline. The web app inserts into this table
-- directly through PostgREST (lib/actions/organisations.ts), and the table-level
-- INSERT grant covers every column — so without this trigger a client could POST
-- its own trial_ends_at and hand itself an unlimited trial.
--
-- It therefore *overwrites* rather than defaults: NEW.trial_ends_at is discarded
-- unconditionally, so a client-supplied value can never survive. Nothing legitimately
-- sets this on insert today, and a trial that needs extending is an UPDATE, which
-- this trigger does not fire on.
CREATE OR REPLACE FUNCTION "public"."set_organisation_trial"()
    RETURNS trigger
    LANGUAGE plpgsql
    -- No SECURITY DEFINER: the function reads and writes only the NEW row that
    -- the caller is already inserting, so it needs no privileges of its own.
    SET search_path = ''
AS $$
BEGIN
    -- Personal orgs are every user's default workspace, auto-created at signup by
    -- handle_new_user(). Trialling one would lock a user out of their own account
    -- seven days after registering, so they are explicitly exempt.
    IF NEW.org_type = 'company' THEN
        NEW.trial_ends_at := now() + interval '7 days';
    ELSE
        NEW.trial_ends_at := NULL;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "organisations_set_trial"
    BEFORE INSERT ON "public"."organisations"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."set_organisation_trial"();


-- Privileges -------------------------------------------------------------
-- RLS on this table is permissive on UPDATE: the "organisations update by org
-- admin" policy restricts which *rows* an admin may write, not which *columns*.
-- Row policies and column privileges are separate gates in Postgres and a
-- permissive policy grants nothing at the column level -- so the column list on
-- the GRANT is the only thing standing between an org admin and their own trial
-- deadline, reachable in one PATCH through PostgREST.
--
-- ReserveInfraSlugs already narrowed UPDATE to ("name", "org_type"), and a
-- column-level grant list does not extend to columns added later, so in a
-- correctly-migrated database trial_ends_at is unwritable the moment it exists.
-- That is restated rather than assumed below, for two reasons: it makes this
-- migration correct against a database where that one never ran or was partially
-- rolled back, and it puts the guarantee in the same file as the column it
-- protects instead of leaving it as action-at-a-distance in another migration.
--
-- Both statements are idempotent against the intended end state, so re-running
-- them where ReserveInfraSlugs already applied is a no-op.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
GRANT UPDATE ("name", "org_type") ON TABLE "public"."organisations" TO "authenticated";

-- anon has no UPDATE policy on this table, so RLS already blocks it; this keeps
-- the privilege and the policy in agreement rather than relying on one of them.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "anon";

-- INSERT is deliberately NOT narrowed here. The table-level INSERT grant does
-- cover every column, so a client can put a value in trial_ends_at on the way in
-- -- which is exactly why set_organisation_trial() overwrites unconditionally
-- rather than defaulting only when NULL. Restricting INSERT column-by-column
-- would add a second, redundant gate whose column list has to be kept in step
-- with the insert path forever; the trigger is authoritative and cannot drift.
--
-- org_type IS still updatable, so an org admin can flip a company org to
-- 'personal' through PostgREST. That does not buy them anything: the deadline is
-- stamped at INSERT and every reader keys off trial_ends_at alone, never off
-- org_type, so a later type change cannot clear a running trial. Creating a
-- second org as 'personal' to dodge the trial is blocked separately, by the
-- partial unique index that allows one personal org per user.
--
-- SELECT is deliberately left alone: members already read their own org row, and
-- the dashboard needs this value to render the countdown.


-- Backfill ---------------------------------------------------------------
-- Intentionally none. Existing company orgs keep trial_ends_at = NULL and stay
-- unrestricted.
--
-- The alternative was rejected on both readings: backfilling created_at + 7 days
-- would expire every existing org the instant this migration lands, and
-- backfilling now() + 7 days would start a trial for orgs that were never told
-- they were on one. Grandfathering is the only option that changes no existing
-- org's access, and this migration ships ahead of any billing enforcement, so
-- there is nothing yet for those orgs to be grandfathered *out of*.
