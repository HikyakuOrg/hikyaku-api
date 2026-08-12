-- Reserved hostnames in the hikyaku.org zone must never be allocated as an org
-- slug. These are live hosts: docs is a separate Vercel project, send is the SES
-- sending domain, origin is what the tenant-proxy Worker forwards to, and
-- www/app/api/admin/auth/static are product + infra hosts.
--
-- tenantUrl() in the web app (lib/subdomain.ts) builds
-- https://<slug>.hikyaku.org/booking, so an org holding one of these names would
-- emit a booking URL that silently serves a different site rather than erroring.
-- The web app's RESERVED set only guards host *reads* (getSlugFromHost), so it
-- cannot prevent allocation — this migration is the allocation-side half.
--
-- Two layers, because they fail differently:
--   1. a CHECK, so no reserved value can land in the column by any route; and
--   2. a column-level UPDATE grant, so tenants cannot rewrite slug at all.
-- The CHECK also backstops layer 2 if the table grant is ever re-broadened.


-- Layer 1 ----------------------------------------------------------------
-- CHECK rather than an application guard: the slug is never user-supplied on
-- the creation path (it comes from the column DEFAULT), so the exposure is on
-- UPDATE, which a create-path guard would miss entirely. A CHECK covers INSERT
-- and UPDATE alike.
--
-- NOTE: adding a CHECK validates existing rows, so this migration fails loudly
-- if an org already holds a reserved slug. That is intentional — such a row
-- needs a deliberate rename, not a silent skip.
ALTER TABLE "public"."organisations"
    ADD CONSTRAINT "organisations_slug_not_reserved_check"
    CHECK ("slug" <> ALL (ARRAY[
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


-- Layer 2 ----------------------------------------------------------------
-- `GRANT ALL ON TABLE organisations TO authenticated` handed out table-level
-- UPDATE, which implies every column. Combined with the "organisations update by
-- org admin" RLS policy — which restricts which *rows* an admin may touch but
-- not which *columns* — any org admin could PATCH their own slug through
-- PostgREST to any value passing organisations_slug_format_check. No UI exposes
-- this; the REST endpoint does.
--
-- Table-level UPDATE has to be revoked before column-level grants mean anything,
-- since the table-level privilege subsumes them. Re-granted columns are the two
-- an org admin legitimately edits; id, created_at, created_by and slug are
-- identity/audit fields. created_by matters as much as slug here: the RLS USING
-- clause keys off it, so a writable created_by lets an admin reassign ownership
-- of the row.
--
-- Nothing in the API or web app updates this table today, so no application code
-- depends on the privileges being dropped. The API connects as service_role /
-- DB_URL, neither of which is affected.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
GRANT UPDATE ("name", "org_type") ON TABLE "public"."organisations" TO "authenticated";

-- anon has no UPDATE policy on this table, so RLS already blocks it; the grant
-- was dead breadth. Removed so the privilege and the policy agree.
REVOKE UPDATE ON TABLE "public"."organisations" FROM "anon";
