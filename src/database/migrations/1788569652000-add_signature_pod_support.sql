-- Signature-on-delivery support: seeds the "Signature" pod_type row (id kept in sync with
-- ShiftActionsRepository.POD_TYPE_SIGNATURE on the mobile client -- Photo is re-inserted too,
-- ON CONFLICT DO NOTHING, since pod_type is currently unseeded on at least one environment) and
-- adds storage.objects RLS for the `packages` bucket, which currently has no policy at all -- that
-- predates this change and has presumably been blocking photo POD uploads too.
--
-- The predicate mirrors package_proof_of_delivery's own existing policy (is_assigned_driver OR
-- has_org_permission(..., 'packages.update'/'packages.view')) rather than introducing a new one.
--
-- The UPDATE policy deliberately excludes the `signature/` sub-path: the photo path
-- (`{packageId}/pod.jpg`) is uploaded with upsert=true and needs UPDATE to support retakes, but a
-- signature is uploaded once (uploadProofSignature never upserts) and getting no UPDATE grant at
-- all means it can't be silently replaced after the fact -- the same guarantee
-- package_proof_of_delivery already has for free by simply having no UPDATE/DELETE policy.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

INSERT INTO "public"."pod_type" ("id", "name", "description")
OVERRIDING SYSTEM VALUE
VALUES
    (2, 'Photo', 'Photo evidence of delivery'),
    (3, 'Signature', 'Customer signature captured on delivery')
ON CONFLICT ("id") DO NOTHING;

CREATE POLICY "packages_bucket_insert"
    ON "storage"."objects" FOR INSERT
    TO "authenticated"
    WITH CHECK (
        bucket_id = 'packages'
        AND (
            is_assigned_driver(((storage.foldername("name"))[1])::uuid)
            OR has_org_permission(package_org(((storage.foldername("name"))[1])::uuid), 'packages.update')
        )
    );

CREATE POLICY "packages_bucket_select"
    ON "storage"."objects" FOR SELECT
    TO "authenticated"
    USING (
        bucket_id = 'packages'
        AND (
            is_assigned_driver(((storage.foldername("name"))[1])::uuid)
            OR has_org_permission(package_org(((storage.foldername("name"))[1])::uuid), 'packages.view')
        )
    );

CREATE POLICY "packages_bucket_update_non_signature"
    ON "storage"."objects" FOR UPDATE
    TO "authenticated"
    USING (
        bucket_id = 'packages'
        AND (storage.foldername("name"))[2] IS DISTINCT FROM 'signature'
        AND (
            is_assigned_driver(((storage.foldername("name"))[1])::uuid)
            OR has_org_permission(package_org(((storage.foldername("name"))[1])::uuid), 'packages.update')
        )
    )
    WITH CHECK (
        bucket_id = 'packages'
        AND (storage.foldername("name"))[2] IS DISTINCT FROM 'signature'
        AND (
            is_assigned_driver(((storage.foldername("name"))[1])::uuid)
            OR has_org_permission(package_org(((storage.foldername("name"))[1])::uuid), 'packages.update')
        )
    );
