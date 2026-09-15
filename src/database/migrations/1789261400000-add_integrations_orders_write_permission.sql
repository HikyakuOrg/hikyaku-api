-- Mints integrations.orders.write, a new trust boundary distinct from
-- customers.add: pushing an external order event into an org over the
-- generic ingestion endpoint (see HIK-105) is a different kind of write than
-- a human adding a customer by hand through the dashboard.
--
-- app_permission.id carries a BY DEFAULT identity sequence, but every row so
-- far was inserted with an explicit id and the sequence's own counter never
-- advanced past 1 -- relying on the identity default here would collide with
-- an existing row on the very next insert. MAX(id)+1 is computed instead.
--
-- WHERE NOT EXISTS makes the insert safe to re-run by hand.
INSERT INTO "public"."app_permission" ("id", "permission")
SELECT (SELECT MAX("id") FROM "public"."app_permission") + 1, 'integrations.orders.write'
WHERE NOT EXISTS (
    SELECT 1 FROM "public"."app_permission" WHERE "permission" = 'integrations.orders.write'
);

-- handle_new_organisation() only auto-grants every existing permission to an
-- org's creator at organisation-creation time, so a permission minted after
-- the fact never reaches an org created before this migration ran. Backfill
-- it to whoever already holds customers.add in each org: the same people who
-- can already add a customer by hand can now also receive one pushed in over
-- the API.
INSERT INTO "public"."user_permission" ("organisation_id", "user_id", "permission_id")
SELECT up."organisation_id", up."user_id", new_perm."id"
FROM "public"."user_permission" up
JOIN "public"."app_permission" existing
    ON existing."id" = up."permission_id" AND existing."permission" = 'customers.add'
CROSS JOIN (
    SELECT "id" FROM "public"."app_permission" WHERE "permission" = 'integrations.orders.write'
) new_perm
ON CONFLICT DO NOTHING;
