-- Lets a personal-org courier delete their own package while it is still
-- PENDING or ASSIGNED. "packages delete org" already exists but gates on
-- has_org_permission(organisation_id, 'packages.delete') -- a personal org has
-- no team_members/role rows for that to resolve through (see
-- is_personal_org_owner), so a courier had no delete path at all, even for a
-- package they added by mistake and never dispatched.
--
-- Narrower than the org policy on purpose: once a package moves past ASSIGNED
-- (ONBOARD_FOR_DELIVERY/IN_TRANSIT/DELIVERED/FAILED) something physical has
-- happened to it, and a DELIVERED/FAILED package typically carries a
-- package_proof_of_delivery row -- whose package_id FK has no ON DELETE
-- CASCADE, so deleting it there would fail with a foreign-key violation
-- anyway. Stopping at ASSIGNED sidesteps that: neither PENDING nor ASSIGNED
-- packages ever have a POD row.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE POLICY "packages delete personal owner"
    ON "public"."packages" FOR DELETE
    TO "authenticated"
    USING (
        "public"."is_personal_org_owner"("organisation_id")
        AND "public"."package_latest_status"("id") IN ('PENDING', 'ASSIGNED')
    );
