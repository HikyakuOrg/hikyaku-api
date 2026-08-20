-- Storage bucket + RLS for organisation logos (AddOrganisationLogo added the
-- organisations.logo_url column that caches the resulting public URL; this
-- migration is what actually lets a browser write the file). Objects are
-- stored at <organisation_id>/logo.<ext> — RLS keys off the first path
-- segment rather than a mapping table, same idea as how avatar/vehicles/
-- packages buckets already scope by id-shaped folder names.
--
-- Public bucket (like `avatar`): logos are embedded in QR codes rendered on
-- customer-facing surfaces (package labels, tracking pages), so they need to
-- be fetchable without an auth header — same reasoning as driver avatars.
-- The explicit SELECT policy below is defence in depth for any caller that
-- goes through the authenticated/anon PostgREST route instead of the public
-- CDN URL; it does not change what getPublicUrl() already exposes.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

INSERT INTO "storage"."buckets" ("id", "name", "public")
VALUES ('org-logos', 'org-logos', true)
ON CONFLICT ("id") DO NOTHING;

CREATE POLICY "org_logos_public_read"
    ON "storage"."objects" FOR SELECT
    TO "public"
    USING (bucket_id = 'org-logos');

-- Write access is scoped to team members of the org named by the object's
-- own top-level folder -- the same organisation_id used as the storage path
-- prefix by uploadOrganisationLogo() (hikyaku lib/supabase/storage.ts).
-- Any team member may write, matching organisations.name/org_type's own
-- authenticated-wide UPDATE grant (ReserveInfraSlugs) -- there is no
-- role-based restriction on those columns either.
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
    );

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
    )
    WITH CHECK (
        bucket_id = 'org-logos'
        AND EXISTS (
            SELECT 1 FROM "public"."team_members" tm
             WHERE tm."id" = auth.uid()
               AND tm."organisation_id"::text = (storage.foldername("name"))[1]
        )
    );

CREATE POLICY "org_logos_team_delete"
    ON "storage"."objects" FOR DELETE
    TO "authenticated"
    USING (
        bucket_id = 'org-logos'
        AND EXISTS (
            SELECT 1 FROM "public"."team_members" tm
             WHERE tm."id" = auth.uid()
               AND tm."organisation_id"::text = (storage.foldername("name"))[1]
        )
    );
