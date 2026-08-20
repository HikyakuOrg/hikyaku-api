-- Company orgs can upload a logo that gets embedded in the centre of every QR
-- code the dashboard renders for them (package labels, etc.) -- see
-- components/qr-code-with-logo.tsx in hikyaku. Stored as the full Supabase
-- Storage public URL (same convention as drivers.avatar_url), not a bare
-- path, so consumers never need to reconstruct it. NULL means "no logo
-- uploaded yet" -- personal orgs never get the branding UI in the first
-- place, same gate as Business Information.
--
-- The `org-logos` storage bucket and its RLS policies are provisioned
-- outside this repo (same as every other bucket -- see data-source.ts's
-- "schema is owned by Supabase" note), by hand in the Supabase dashboard.
-- This column is only the cached reference to whatever object currently
-- lives at <organisation_id>/logo.<ext> there.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "public"."organisations"
    ADD COLUMN "logo_url" text;

COMMENT ON COLUMN "public"."organisations"."logo_url" IS
    'Public Supabase Storage URL of the org''s uploaded logo (org-logos '
    'bucket, path <organisation_id>/logo.<ext>). NULL when no logo has been '
    'uploaded. Settable by any team member, same as name/org_type.';

-- Extend the existing column-level UPDATE grant (ReserveInfraSlugs) to cover
-- logo_url alongside name/org_type -- restated defensively, same pattern as
-- every migration since then.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
GRANT UPDATE ("name", "org_type", "logo_url") ON TABLE "public"."organisations" TO "authenticated";
REVOKE UPDATE ON TABLE "public"."organisations" FROM "anon";
