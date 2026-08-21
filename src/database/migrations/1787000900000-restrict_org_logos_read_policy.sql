-- org_logos_public_read (from AddOrgLogosStorageBucket) granted SELECT on
-- storage.objects to "public" for the whole bucket. That doesn't just let a
-- caller fetch a logo it already knows the path to -- it lets anyone call the
-- Storage API's list/get-by-prefix operations and enumerate every
-- organisation_id folder in the bucket, since RLS filters rows, not query
-- shape. The public bucket URL (getPublicUrl(), used for QR codes/tracking
-- pages) doesn't consult storage.objects RLS at all -- it only checks
-- buckets.public -- so that policy was doing nothing for the anonymous
-- rendering path it was justified by, and only added the enumeration surface.
--
-- Replace it with the same team-membership scope already used by the write
-- policies: authenticated team members can list/read via the API, nobody can
-- enumerate the bucket anonymously, and public logo delivery is unaffected.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DROP POLICY IF EXISTS "org_logos_public_read" ON "storage"."objects";

CREATE POLICY "org_logos_team_read"
    ON "storage"."objects" FOR SELECT
    TO "authenticated"
    USING (
        bucket_id = 'org-logos'
        AND EXISTS (
            SELECT 1 FROM "public"."team_members" tm
             WHERE tm."id" = auth.uid()
               AND tm."organisation_id"::text = (storage.foldername("name"))[1]
        )
    );
