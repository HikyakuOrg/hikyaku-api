-- Only a company org may carry a logo. AddOrganisationLogo added `logo_url`
-- and extended the column-level UPDATE grant to cover it for `authenticated`,
-- on the reasoning that "personal orgs never get the branding UI in the first
-- place". That is a statement about the dashboard, not about the database: the
-- web app PATCHes public.organisations straight through PostgREST
-- (lib/actions/organisations.ts), so a personal account can set its own
-- logo_url in one request without ever loading the UI that is supposed to gate
-- it. Nothing in the API writes this column, so the dashboard was the only
-- thing enforcing the rule.
--
-- The rule is enforced at both layers a logo actually occupies: a trigger on
-- public.organisations for the reference, and the org-logos storage policies
-- for the bytes. Doing only the first would leave a personal account able to
-- PUT a file into a public bucket and get a live CDN URL for it -- unreferenced
-- by any column, but uploaded all the same, which is the thing being refused.
--
-- Why a trigger and not a narrower grant: column privileges are per-column, not
-- per-row -- there is no way to grant UPDATE (logo_url) to the members of a
-- company org and withhold it from the members of a personal one, because the
-- deciding value (org_type) lives on the row being written. Same reason
-- LimitPersonalOrgWarehouses is a trigger rather than a partial unique index.
--
-- Why not an RLS WITH CHECK: it would fire on every UPDATE of the row rather
-- than only the ones that touch logo_url, so it could not tell "setting a logo"
-- apart from "renaming an org that already has one", and it would refuse the
-- company -> personal downgrade below instead of resolving it. RLS also does
-- not apply to service_role, which is precisely the caller a data-integrity
-- rule should still hold for.

SET lock_timeout = '5s';
SET statement_timeout = '30s';


-- Trigger ------------------------------------------------------------------
-- No SECURITY DEFINER, unlike enforce_personal_org_warehouse_limit(): every
-- value this needs is on the NEW/OLD row the caller is already writing, so it
-- reads no other table and needs no privileges of its own -- same reasoning as
-- set_organisation_trial() (AddOrganisationTrial).
CREATE OR REPLACE FUNCTION "public"."enforce_company_org_logo"()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = ''
AS $$
BEGIN
    -- Company orgs are what the branding feature exists for. Nothing below
    -- applies to them.
    IF NEW.org_type = 'company' THEN
        RETURN NEW;
    END IF;

    -- company -> personal downgrade. Clear the logo rather than refuse the
    -- flip: set_organisation_vanity_slug() (AddOrganisationVanitySlug) already
    -- nulls vanity_slug on this exact transition, and leaving the two branding
    -- fields disagreeing -- a personal org whose vanity host has stopped
    -- resolving but whose logo URL is still live and still embedded in every QR
    -- code -- is worse than either outcome on its own. Raising here instead
    -- would also block a legitimate downgrade behind a field the user cannot
    -- see, which is not this trigger's call to make.
    --
    -- This runs before the logo_url branches below deliberately: a PATCH that
    -- sets org_type and logo_url in the same request lands here and the logo is
    -- dropped, rather than being read as a personal org setting one.
    IF TG_OP = 'UPDATE' AND NEW.org_type IS DISTINCT FROM OLD.org_type THEN
        NEW.logo_url := NULL;
        RETURN NEW;
    END IF;

    -- Removing a logo is always allowed, whatever the org type. This is also
    -- the branch every ordinary personal-org INSERT takes, since logo_url is
    -- NULL on all of them.
    IF NEW.logo_url IS NULL THEN
        RETURN NEW;
    END IF;

    -- A write that leaves logo_url byte-for-byte as it was is not an attempt to
    -- set one. Without this, a personal org that already carried a logo when
    -- this migration landed could never be renamed again -- the rename would
    -- resend the existing value and be refused. Those rows are left as they are
    -- rather than rewritten; see the notice at the bottom.
    IF TG_OP = 'UPDATE' AND NEW.logo_url IS NOT DISTINCT FROM OLD.logo_url THEN
        RETURN NEW;
    END IF;

    -- check_violation (23514) for the same reason as
    -- enforce_personal_org_warehouse_limit(): PostgREST maps it to HTTP 400 and
    -- passes message/detail/hint through verbatim, so the dashboard can show
    -- this sentence as-is, and the SQLSTATE says what it actually is to
    -- anything reading the code rather than the prose.
    RAISE EXCEPTION
        'Personal accounts cannot set an organisation logo.'
        USING ERRCODE = 'check_violation',
              DETAIL  = format('Organisation %s is a personal account; logo_url is only writable on a company organisation.',
                               NEW.id),
              HINT    = 'Create a company organisation to upload a logo.';
END;
$$;

COMMENT ON FUNCTION "public"."enforce_company_org_logo"() IS
    'Restricts organisations.logo_url to company orgs. Clears it on a '
    'company -> personal downgrade (mirroring vanity_slug), allows clearing it '
    'and leaving it untouched, and raises 23514 (check_violation) on any '
    'attempt to set one on a personal org.';

DROP TRIGGER IF EXISTS "organisations_company_logo_only" ON "public"."organisations";

-- UPDATE OF org_type is covered as well as logo_url, for the downgrade branch:
-- a PATCH that only flips org_type would otherwise not fire this at all and
-- would leave a live logo on a personal org. Listing both columns also keeps
-- the trigger off the rename path entirely -- an UPDATE that mentions neither
-- (PostgREST sends only the columns in the request body) never runs it.
CREATE TRIGGER "organisations_company_logo_only"
    BEFORE INSERT OR UPDATE OF "logo_url", "org_type" ON "public"."organisations"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."enforce_company_org_logo"();


-- Privileges ---------------------------------------------------------------
-- The column-level grant is deliberately unchanged: logo_url stays writable by
-- `authenticated` because a company org's team members legitimately write it,
-- and a grant cannot express "only when this row is a company org". The trigger
-- above is the row-level half of the rule and the grant is the column-level
-- half; neither is sufficient alone. Restated defensively, same as every
-- migration since ReserveInfraSlugs, so this file is correct against a database
-- where AddOrganisationLogo never ran.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
GRANT UPDATE ("name", "org_type", "logo_url") ON TABLE "public"."organisations" TO "authenticated";
REVOKE UPDATE ON TABLE "public"."organisations" FROM "anon";

COMMENT ON COLUMN "public"."organisations"."logo_url" IS
    'Public Supabase Storage URL of the org''s uploaded logo (org-logos '
    'bucket, path <organisation_id>/logo.<ext>). NULL when no logo has been '
    'uploaded. Settable by any team member of a COMPANY org; personal orgs are '
    'refused by enforce_company_org_logo(), which also clears it on a '
    'company -> personal downgrade.';

-- Storage ------------------------------------------------------------------
-- The trigger above governs the reference; these policies govern the bytes.
-- org_logos_team_insert / _update (AddOrgLogosStorageBucket) scope writes to
-- team members of the org named by the object's own folder, with no org_type
-- condition -- so without this, a personal account can still PUT
-- <organisation_id>/logo.<ext> into a PUBLIC bucket and get a permanently
-- fetchable CDN URL for it. That the URL has nowhere to be recorded is not the
-- point: the upload is the write, and it should be refused at the same place
-- every other write to this bucket is authorised.
--
-- Only INSERT and UPDATE are narrowed. DELETE and SELECT are deliberately left
-- as they are -- see the note at the bottom.

-- The org_type lookup goes through a SECURITY DEFINER function rather than a
-- bare EXISTS on public.organisations, for the same reason
-- enforce_personal_org_warehouse_limit() and enforce_shift_allowance() both
-- cite: the caller may not be able to SELECT the row under RLS. An RLS policy
-- expression is evaluated as the invoking user, so an inline subquery here
-- would silently return "not a company" for any caller whose view of
-- public.organisations is narrower than expected -- and, because that is the
-- deny direction, it would break logo upload for legitimate company orgs
-- rather than fail loudly. The organisations SELECT policy lives in the
-- Supabase dashboard, not in this repo, so depending on its exact shape from
-- here is not something this migration can verify.
--
-- Takes text, not uuid, and compares id::text: it is fed the first path
-- segment of an object name, which is attacker-controlled and need not be a
-- uuid at all. A uuid cast would raise 22P02 on a junk folder name instead of
-- returning false, and AND does not guarantee left-to-right evaluation, so the
-- neighbouring team_members check cannot be relied on to short-circuit it. The
-- cast direction costs the index on organisations.id; the table is small and
-- this runs once per logo upload.
CREATE OR REPLACE FUNCTION "public"."is_company_organisation"(
    "p_organisation_id" text
)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.organisations o
         WHERE o.id::text = p_organisation_id
           AND o.org_type = 'company'
    );
$$;

COMMENT ON FUNCTION "public"."is_company_organisation"(text) IS
    'Whether the given organisation id (as text -- callers pass an untrusted '
    'storage path segment) belongs to a company org. SECURITY DEFINER so an '
    'RLS policy expression gets the real answer rather than whatever the '
    'invoking user can see. Returns false for a missing or malformed id.';

-- EXECUTE is granted to PUBLIC by default, which would let anon probe org ids
-- for their type. The policies below are TO authenticated, so that is the only
-- role that needs it.
REVOKE EXECUTE ON FUNCTION "public"."is_company_organisation"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."is_company_organisation"(text) TO "authenticated";

-- Recreated rather than ALTERed: Postgres has no way to amend a policy's
-- expression in place without restating it, so the whole predicate is written
-- out, team-membership clause included, exactly as AddOrgLogosStorageBucket
-- had it plus the org_type condition.
DROP POLICY IF EXISTS "org_logos_team_insert" ON "storage"."objects";

CREATE POLICY "org_logos_team_insert"
    ON "storage"."objects" FOR INSERT
    TO "authenticated"
    WITH CHECK (
        bucket_id = 'org-logos'
        AND EXISTS (
            SELECT 1 FROM "public"."team_members" tm
             WHERE tm."id" = auth.uid()
               AND tm."organisation_id"::text = (storage.foldername("name"))[1]
        )
        AND "public"."is_company_organisation"((storage.foldername("name"))[1])
    );

DROP POLICY IF EXISTS "org_logos_team_update" ON "storage"."objects";

CREATE POLICY "org_logos_team_update"
    ON "storage"."objects" FOR UPDATE
    TO "authenticated"
    USING (
        bucket_id = 'org-logos'
        AND EXISTS (
            SELECT 1 FROM "public"."team_members" tm
             WHERE tm."id" = auth.uid()
               AND tm."organisation_id"::text = (storage.foldername("name"))[1]
        )
        AND "public"."is_company_organisation"((storage.foldername("name"))[1])
    )
    WITH CHECK (
        bucket_id = 'org-logos'
        AND EXISTS (
            SELECT 1 FROM "public"."team_members" tm
             WHERE tm."id" = auth.uid()
               AND tm."organisation_id"::text = (storage.foldername("name"))[1]
        )
        AND "public"."is_company_organisation"((storage.foldername("name"))[1])
    );


-- Existing data ------------------------------------------------------------
-- Nothing is rewritten. The trigger gates new writes; a personal org that
-- already holds a logo keeps it and simply cannot change it to anything other
-- than NULL. Stripping branding a tenant is already using, to satisfy a rule
-- introduced after the fact, is not a migration's call to make -- same position
-- as LimitPersonalOrgWarehouses took on over-cap warehouses.
--
-- The notice is so whoever runs this can see whether the case exists in the
-- target database. To clear them, run this by hand afterwards -- it is left out
-- of the migration on purpose:
--
--   UPDATE public.organisations SET logo_url = NULL
--    WHERE org_type <> 'company' AND logo_url IS NOT NULL;
DO $$
DECLARE
    v_branded integer;
BEGIN
    SELECT count(*)
      INTO v_branded
      FROM public.organisations o
     WHERE o.org_type <> 'company'
       AND o.logo_url IS NOT NULL;

    IF v_branded > 0 THEN
        RAISE NOTICE '% personal organisation(s) already have a logo_url set. These are left untouched: the existing logo stays, but it can no longer be changed to anything but NULL.', v_branded;
    END IF;
END;
$$;



-- Out of scope --------------------------------------------------------------
-- org_logos_team_delete and org_logos_team_read are left untouched on purpose.
-- Both are the cleanup path, and narrowing them to company orgs would strand
-- exactly the objects this migration creates: a company org that downgrades has
-- its logo_url cleared by the trigger above but keeps its bytes in the bucket,
-- and a personal org that uploaded one before this migration landed keeps its
-- too. If DELETE required org_type = 'company', neither could ever be removed
-- by the team that owns it -- a storage leak, entered into deliberately, to
-- close a hole that is about writing rather than reading. Listing an object you
-- own and deleting it are not the privilege being withheld here.
--
-- Those orphans are not enumerated or removed by this migration; the objects
-- are inert once no logo_url points at them, and picking which to delete is a
-- data decision, not a schema one. To find them:
--
--   SELECT o.name
--     FROM storage.objects o
--    WHERE o.bucket_id = 'org-logos'
--      AND NOT public.is_company_organisation((storage.foldername(o.name))[1]);
