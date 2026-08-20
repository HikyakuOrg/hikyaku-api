-- Organisation ("company") accounts get a human-readable vanity booking
-- subdomain derived from their business name, e.g. "Acme Couriers" ->
-- acme-couriers.hikyaku.org, alongside the existing opaque `slug`
-- (<random>.hikyaku.org, never removed — see AddOrganisationTrial-era
-- comments for why the opaque slug exists at all). `name` is already globally
-- UNIQUE (organisations_name_key), but two different unique names can
-- slugify to the same value (e.g. "Acme, Inc." and "Acme Inc"), so this
-- column needs its own uniqueness and its own collision handling.
--
-- Whether a vanity host is actually SERVED is decided later, in
-- get_booking_organisation()/get_tracking_details() (see
-- ResolveOrganisationsByVanitySlug) against the org's live Stripe
-- entitlement -- this migration only ever generates and stores the value.
-- Personal orgs (name IS NULL) never get one.

SET lock_timeout = '5s';
SET statement_timeout = '30s';


-- Column + constraints -----------------------------------------------------
-- Nullable with no DEFAULT, same reasoning as trial_ends_at
-- (AddOrganisationTrial): the value depends on org_type/name, which a column
-- DEFAULT cannot branch on, so the trigger below is the only writer.
ALTER TABLE "public"."organisations"
    ADD COLUMN "vanity_slug" text;

COMMENT ON COLUMN "public"."organisations"."vanity_slug" IS
    'Human-readable booking subdomain derived from name, e.g. acme-couriers. '
    'NULL for personal orgs and any company org whose name has no sluggable '
    'characters. Set by set_organisation_vanity_slug() on INSERT and on '
    'UPDATE OF name, and not writable by tenants. Whether it currently '
    'resolves to anything depends on the org''s live vanity_url entitlement '
    '-- see get_booking_organisation().';

-- Format mirrors organisations_slug_format_check but allows hyphens (a slug
-- built from a multi-word business name needs them); 3-63 chars is the DNS
-- label limit floor/ceiling.
ALTER TABLE "public"."organisations"
    ADD CONSTRAINT "organisations_vanity_slug_format_check"
    CHECK ("vanity_slug" IS NULL OR "vanity_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    ADD CONSTRAINT "organisations_vanity_slug_length_check"
    CHECK ("vanity_slug" IS NULL OR char_length("vanity_slug") BETWEEN 3 AND 63);

-- Plain UNIQUE: Postgres never treats NULLs as equal to each other, so every
-- personal org's NULL (and any unsluggable company name's NULL) coexists
-- fine without a partial-index workaround.
ALTER TABLE "public"."organisations"
    ADD CONSTRAINT "organisations_vanity_slug_key" UNIQUE ("vanity_slug");

-- Same reserved-host list as organisations_slug_not_reserved_check
-- (ReserveInfraSlugs) -- a vanity slug landing on one of these would emit a
-- booking URL that silently serves a different site, same as the opaque slug
-- would. The trigger below already avoids generating these (see its
-- disambiguation branch); this CHECK is defense-in-depth, same two-layer
-- reasoning as ReserveInfraSlugs.
ALTER TABLE "public"."organisations"
    ADD CONSTRAINT "organisations_vanity_slug_not_reserved_check"
    CHECK ("vanity_slug" <> ALL (ARRAY[
        'www',
        'app',
        'api',
        'admin',
        'auth',
        'static',
        'docs',
        'send',
        'origin'
    ]::"text"[]));


-- Trigger --------------------------------------------------------------
-- BEFORE INSERT (new company org), BEFORE UPDATE OF name (rename), and
-- BEFORE UPDATE OF org_type -- vanity_slug is kept in sync with name by
-- design (user-confirmed: not a separately settable value), so a rename
-- regenerates it and the previous vanity host simply stops resolving, same
-- as any other unclaimed subdomain. org_type is included too: ReserveInfraSlugs
-- already grants authenticated org admins UPDATE on ("name", "org_type"), so a
-- company org can be flipped to 'personal' without touching name at all --
-- without this, that path would leave a stale, non-NULL vanity_slug (and
-- name) on what is now nominally a personal org.
--
-- SECURITY DEFINER, unlike set_organisation_trial() (AddOrganisationTrial)
-- which only ever touches the NEW row: collision detection here has to see
-- every org's vanity_slug globally, not just the rows RLS lets the inserting/
-- renaming user see.
CREATE OR REPLACE FUNCTION "public"."set_organisation_vanity_slug"()
    RETURNS "trigger"
    LANGUAGE "plpgsql"
    SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    v_base text;
    v_candidate text;
    v_reserved CONSTANT text[] := ARRAY[
        'www', 'app', 'api', 'admin', 'auth', 'static', 'docs', 'send', 'origin'
    ];
BEGIN
    IF NEW.org_type <> 'company' OR NEW.name IS NULL THEN
        NEW.vanity_slug := NULL;
        RETURN NEW;
    END IF;

    -- lowercase, collapse any run of non-[a-z0-9] into a single hyphen, trim
    -- leading/trailing hyphens, cap at the DNS label limit.
    v_base := lower(NEW.name);
    v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
    v_base := btrim(v_base, '-');
    v_base := left(v_base, 63);

    -- An all-symbols / non-Latin name (no [a-z0-9] survives) has nothing to
    -- slugify -- the org simply gets no vanity URL rather than blocking the
    -- insert/rename.
    IF v_base = '' THEN
        NEW.vanity_slug := NULL;
        RETURN NEW;
    END IF;

    v_candidate := v_base;

    -- Pre-check and disambiguate rather than let the UNIQUE constraint fail
    -- the statement: createOrganisation() (hikyaku/lib/actions/organisations.ts)
    -- only catches Postgres 23505 on `name` and reports it as a name clash --
    -- a coincidental vanity_slug collision between two different,
    -- legitimately-unique names must never surface that misleading error or
    -- fail org creation/rename outright.
    IF v_candidate = ANY (v_reserved)
       OR EXISTS (
           SELECT 1 FROM "public"."organisations" o
            WHERE o."vanity_slug" = v_candidate
              AND o."id" IS DISTINCT FROM NEW."id"
       )
    THEN
        -- id is already populated pre-trigger (gen_random_uuid() is the
        -- column DEFAULT), so a short slice of it is available as a cheap,
        -- deterministic-enough disambiguator with no retry loop needed.
        v_candidate := left(v_base, 55) || '-' || substr(replace(NEW."id"::text, '-', ''), 1, 6);
    END IF;

    NEW.vanity_slug := v_candidate;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "organisations_set_vanity_slug"
    BEFORE INSERT OR UPDATE OF "name", "org_type" ON "public"."organisations"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."set_organisation_vanity_slug"();


-- Privileges -------------------------------------------------------------
-- Restated defensively, same reasoning as every migration since
-- ReserveInfraSlugs: vanity_slug is deliberately never added to this list,
-- so it stays trigger/service-role-only, and this is correct even against a
-- database where an earlier migration in the chain never ran.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
GRANT UPDATE ("name", "org_type") ON TABLE "public"."organisations" TO "authenticated";
REVOKE UPDATE ON TABLE "public"."organisations" FROM "anon";
