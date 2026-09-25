-- Per-organisation dispatch settings, replacing three process-wide environment
-- variables: ASSIGNMENT_MODE, LOAD_SPREAD_ENABLED and SERVICE_AREA_MATCHING.
-- Each was read from process.env on every assignment, so one deployment gave
-- one answer to every tenant it served: turning service area matching on for a
-- pilot organisation turned it on for all of them at the same instant, which
-- docs/service-area-rollout.md carried as a known limitation. Each organisation
-- now owns its answer and changes it from Settings > Dispatch in the web
-- dashboard, which writes this table straight through PostgREST under the RLS
-- below, like driving_limit_profile.
--
-- What ships here:
--   1. organisation_dispatch_settings, at most one row per organisation.
--   2. A touch trigger that keeps updated_at and updated_by honest and
--      refuses to move a row to another organisation.
--   3. RLS: any org member reads, organisation.edit writes.
--   4. Grants.
--   5. package_assignment.coverage_outcome's comment, which named the env var.
--
-- The TypeORM class that runs this file also carries a deployment's
-- non-default env values into rows, once, so the deploy that ships this
-- changes nobody's routing. See CreateOrganisationDispatchSettings1789693200000.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO ROW MEANS THE DEFAULTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A row is written the first time somebody saves the settings page. It is not
-- backfilled for every organisation and kept in step by a trigger on
-- organisations: an organisation without a row runs on exactly the column
-- defaults below, and a trigger would add a new way for organisation sign-up
-- to fail in front of a row that says nothing its absence does not.
--
-- The defaults are the old env defaults: instant assignment, load spreading
-- on, service area matching off. Three places have to agree on them while an
-- organisation has no row: the DEFAULT clauses here, DEFAULT_DISPATCH_SETTINGS
-- in src/dispatch/dispatch-settings.ts, and the web dashboard's copy in
-- lib/dispatch-settings.ts. dispatch-settings.spec.ts reads this file and fails
-- if the API's copy drifts from it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PERMISSION: organisation.edit, reused
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No new permission is minted, for the reason
-- CreateDrivingLimitProfile1789261200000 reused drivers.update. These settings
-- sit in the same Settings area as the organisation's default driving limit
-- profile, which organisation.edit already governs, and both are
-- organisation-wide dispatch policy set by whoever administers the
-- organisation. Two of the three also
-- move money: load spreading and service area matching can each open a billed
-- shift that would not otherwise have been opened, so the grant belongs with
-- the people who run the organisation rather than with every dispatcher who
-- places packages. handle_new_organisation() grants an organisation's creator
-- every seeded permission, so the policies need no created_by clause.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. The table ─────────────────────────────────────────────────────────────
--
-- organisation_id is the primary key: one row per organisation, and the
-- conflict target the dashboard's upsert (INSERT ... ON CONFLICT DO UPDATE)
-- needs, without a second index.
--
-- assignment_mode is text plus a CHECK rather than a Postgres enum, like
-- package_assignment.coverage_outcome, so a later mode is a constraint swap
-- rather than an ALTER TYPE. `manual` is the old ASSIGNMENT_MODE=nightly under
-- an honest name: there is no nightly scheduler left, and what the setting
-- does is leave new packages PENDING until a dispatcher places them.
--
-- updated_by has no foreign key to auth.users on purpose: it is an audit
-- trail, and deleting a user must neither fail on it nor rewrite it. It is
-- NULL for a row written by anything other than a signed-in dashboard user,
-- the migration's own carry-over included.

CREATE TABLE IF NOT EXISTS "public"."organisation_dispatch_settings" (
    "organisation_id"       uuid        NOT NULL,
    "assignment_mode"       text        NOT NULL DEFAULT 'instant',
    "load_spread_enabled"   boolean     NOT NULL DEFAULT true,
    "service_area_matching" boolean     NOT NULL DEFAULT false,
    "created_at"            timestamptz NOT NULL DEFAULT now(),
    "updated_at"            timestamptz NOT NULL DEFAULT now(),
    "updated_by"            uuid,

    CONSTRAINT "organisation_dispatch_settings_pkey"
        PRIMARY KEY ("organisation_id"),

    CONSTRAINT "organisation_dispatch_settings_organisation_id_fkey"
        FOREIGN KEY ("organisation_id")
        REFERENCES "public"."organisations" ("id")
        ON DELETE CASCADE,

    CONSTRAINT "organisation_dispatch_settings_assignment_mode_chk"
        CHECK ("assignment_mode" IN ('instant', 'manual'))
);

ALTER TABLE "public"."organisation_dispatch_settings" OWNER TO "postgres";

COMMENT ON TABLE "public"."organisation_dispatch_settings" IS
    'How automatic assignment behaves for one organisation, set from Settings > Dispatch. At most one row per organisation, written the first time the settings are saved; an organisation with no row runs on the column defaults. Read by hikyaku-api on every assignment (src/dispatch/dispatch-settings.ts). Replaces the process-wide ASSIGNMENT_MODE, LOAD_SPREAD_ENABLED and SERVICE_AREA_MATCHING environment variables.';

COMMENT ON COLUMN "public"."organisation_dispatch_settings"."assignment_mode" IS
    '`instant`: a new package is placed on a shift as soon as it is created. `manual`: automatic assignment is off and new packages stay PENDING until a dispatcher assigns them. Formerly ASSIGNMENT_MODE, whose `nightly` value meant what `manual` means here.';

COMMENT ON COLUMN "public"."organisation_dispatch_settings"."load_spread_enabled" IS
    'Whether assignment charges a shift for the stops it already carries (LOAD_SPREAD_SECONDS_PER_STOP in src/dispatch/insertion.ts), spreading packages across the vans already out instead of filling the first. Formerly LOAD_SPREAD_ENABLED.';

COMMENT ON COLUMN "public"."organisation_dispatch_settings"."service_area_matching" IS
    'Whether assignment prefers a driver whose service area covers the delivery address, opening a shift for a covering driver before sending a package outside anyone''s territory. Off means service_areas and driver_service_area are not read during assignment at all. Formerly SERVICE_AREA_MATCHING; see docs/service-area-rollout.md.';

COMMENT ON COLUMN "public"."organisation_dispatch_settings"."updated_by" IS
    'auth.uid() of whoever last wrote the row, set by the touch trigger. NULL when it was written by something other than a signed-in dashboard user, such as the migration that created the table.';

-- ── 2. Touch trigger ─────────────────────────────────────────────────────────
--
-- Mirrors driving_limit_profile_touch, and additionally:
--
--   - stamps updated_by, because "who switched service area matching on, and
--     when" is the first question after an organisation's shift bill moves;
--   - keeps created_at from being rewritten by an UPDATE;
--   - refuses to change organisation_id. The update policy checks the
--     permission on the row as it ends up, so somebody holding
--     organisation.edit in two organisations could otherwise move one's
--     settings onto the other. The dashboard's upsert re-sets the column to
--     the value it already has, which IS DISTINCT FROM lets through.

CREATE OR REPLACE FUNCTION "public"."organisation_dispatch_settings_touch"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.organisation_id IS DISTINCT FROM OLD.organisation_id THEN
            RAISE EXCEPTION 'organisation_dispatch_settings.organisation_id cannot be changed';
        END IF;
        NEW.created_at := OLD.created_at;
    END IF;
    NEW.updated_at := now();
    NEW.updated_by := auth.uid();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."organisation_dispatch_settings_touch"() IS
    'Sets updated_at and updated_by on every INSERT and UPDATE of organisation_dispatch_settings, including the PostgREST writes the web dashboard makes, which list neither column. Also pins created_at and organisation_id on UPDATE.';

DROP TRIGGER IF EXISTS "organisation_dispatch_settings_touch" ON "public"."organisation_dispatch_settings";

CREATE TRIGGER "organisation_dispatch_settings_touch"
    BEFORE INSERT OR UPDATE ON "public"."organisation_dispatch_settings"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."organisation_dispatch_settings_touch"();

-- ── 3. RLS ────────────────────────────────────────────────────────────────────
--
-- Any member reads: a dispatcher placing packages by hand should be able to
-- see why nothing is being placed for them. organisation.edit inserts and
-- updates (see the header). No DELETE policy, and no DELETE grant below:
-- going back to the defaults is a save of the default values, so there is no
-- write that needs a row to disappear. DROP then CREATE because PostgreSQL has
-- no CREATE POLICY IF NOT EXISTS, and this file has to survive being re-run by
-- hand.

ALTER TABLE "public"."organisation_dispatch_settings" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dispatch settings select org members" ON "public"."organisation_dispatch_settings";
CREATE POLICY "dispatch settings select org members"
    ON "public"."organisation_dispatch_settings"
    FOR SELECT TO "authenticated"
    USING ("public"."is_org_member"("organisation_id"));

DROP POLICY IF EXISTS "dispatch settings insert org admins" ON "public"."organisation_dispatch_settings";
CREATE POLICY "dispatch settings insert org admins"
    ON "public"."organisation_dispatch_settings"
    FOR INSERT TO "authenticated"
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'organisation.edit'::"text"));

DROP POLICY IF EXISTS "dispatch settings update org admins" ON "public"."organisation_dispatch_settings";
CREATE POLICY "dispatch settings update org admins"
    ON "public"."organisation_dispatch_settings"
    FOR UPDATE TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'organisation.edit'::"text"))
    WITH CHECK ("public"."has_org_permission"("organisation_id", 'organisation.edit'::"text"));

-- ── 4. Grants ────────────────────────────────────────────────────────────────
--
-- The Supabase baseline's default privileges grant ALL on every new table in
-- public to anon and authenticated (see
-- RevokeTruncateTriggerFromAnonAndAuthenticated1789002000000), so both are
-- revoked first and authenticated is given back exactly what the dashboard
-- uses. UPDATE is table-wide rather than per column because PostgREST's upsert
-- re-sets every column in the payload, organisation_id included, on conflict;
-- the touch trigger above is what keeps that column fixed. anon gets nothing:
-- the booking site has no business reading dispatch policy.
--
-- service_role keeps everything. hikyaku-api reads this table on every
-- assignment, always with an explicit organisation_id predicate rather than
-- relying on RLS, matching how src/dispatch/coverage.ts reads
-- driver_service_area.

REVOKE ALL ON TABLE "public"."organisation_dispatch_settings" FROM "anon";
REVOKE ALL ON TABLE "public"."organisation_dispatch_settings" FROM "authenticated";
GRANT SELECT, INSERT, UPDATE ON TABLE "public"."organisation_dispatch_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."organisation_dispatch_settings" TO "service_role";

-- ── 5. coverage_outcome's comment ────────────────────────────────────────────
--
-- Same text as AddAssignmentCoverageOutcome1788829200000 wrote, with the
-- `disabled` clause pointed at the column that now decides it.

COMMENT ON COLUMN "public"."package_assignment"."coverage_outcome" IS
    'How the driver that got this package related to who covers its delivery point, recorded at placement time because none of the inputs to that decision are versioned. NULL means the row was not written by automatic assignment (a replan or a dispatcher''s hand edit), so `WHERE coverage_outcome IS NOT NULL` is the automatically-assigned population. `covered`: a territory the driver is staffed on contains the point. `floater`: the driver matched only because they have no territories at all, which is most matches while the map is half drawn and is why it is not merged into `covered`. `fallback_no_covering_capacity`: somebody covers the point but none of them had room or an idle van. `fallback_no_covering_driver`: nobody covers it at all. `disabled`: service area matching was off for the organisation (organisation_dispatch_settings.service_area_matching) and no coverage question was asked. See src/dispatch/coverage.ts.';
