--
-- Context: the Supabase baseline (infra/db/schema.sql lines 7460-7482) ends
-- with ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT
-- ALL ON TABLES TO postgres, anon, authenticated and service_role, and the
-- per-table grants made at project init (same dump, lines 7194+) are ALL as
-- well. ALL on tables means SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN — but every RLS policy in this database
-- gates exactly one of the four CRUD commands (pg_policy shows polcmd
-- r/d/i/u only, never ALL). TRUNCATE and TRIGGER therefore sit outside what
-- RLS can govern:
--
--   - TRUNCATE is an all-or-nothing table operation. Row-level security does
--     not apply to it, period: a session holding the privilege can empty any
--     table whatever the policies on that table say.
--   - TRIGGER is the right to CREATE OR REPLACE / DROP triggers on the table
--     — NOT the right to fire existing ones, which rides on the write
--     privilege. It lets the holder wire any existing trigger function onto
--     any table where they hold it, and public already ships trigger
--     functions (the realtime broadcast ones, the touch/audit ones) that a
--     creative session could attach where they were never meant to run.
--
-- Today the hole is unreachable in practice: anon and authenticated are
-- served exclusively by PostgREST, which maps HTTP verbs to constrained CRUD
-- and has no verb that becomes TRUNCATE or DDL. But the grants are real and
-- schema-wide (verified on staging: every table plus the
-- packages_with_latest_status view carries anon/authenticated=arwdDxtm),
-- and they turn live the moment any future code path executes raw SQL as
-- one of these roles — an RPC that is not SECURITY DEFINER, an edge
-- function, an admin tool. Removing exactly these two privileges from
-- exactly these two untrusted roles costs nothing today and closes that
-- class of accident permanently.
--
-- HIK-33 scoped the revoke to authenticated; the same baseline granted the
-- same bits to anon, which is strictly less trusted (it is what the booking
-- site's unauthenticated reads run as), so both are revoked here.
--
-- What is deliberately NOT touched:
--   - service_role: the trusted server-side role (the API's supabase-js
--     client holds the service key) — it is supposed to be able to do
--     anything.
--   - SELECT/INSERT/UPDATE/DELETE/REFERENCES/MAINTAIN: everything RLS
--     policies are written to gate and everything PostgREST can express.
--     Normal CRUD through PostgREST is unaffected by construction.
--   - SEQUENCES: the default ALL on sequences is what makes nextval() on id
--     sequences work for inserts by these roles; touching it would break
--     every INSERT.
--
-- Nothing relies on the revoked bits: the only TRUNCATE in the codebase is
-- the tzdata import worker (src/tzdata/tzdata-import.worker.ts), which
-- truncates tzdata.timezone — not public, and as the migration role over a
-- direct DB_MIGRATION_URL connection, never as anon/authenticated. Every
-- CREATE/DROP TRIGGER lives in these migrations, run as postgres. Table
-- triggers keep firing for authenticated writes, because firing a trigger
-- requires the write privilege, not TRIGGER.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Every existing table ────────────────────────────────────────────────────
--
-- The per-table ACLs were all granted BY postgres (anon/authenticated
-- =arwdDxtm/postgres on the live databases), so the migration connection
-- can revoke them. No table list is spelled out: REVOKE ON ALL TABLES IN
-- SCHEMA stays correct against tables later migrations create, is a no-op
-- where the bits are already absent, and sweeps the view too, whose
-- inherited TRUNCATE bit is meaningless (views cannot be truncated) but
-- still worth not carrying around.

REVOKE TRUNCATE, TRIGGER ON ALL TABLES IN SCHEMA "public" FROM "anon", "authenticated";

-- ── 2. The default-privileges rule for future tables ──────────────────────────
--
-- The rule HIK-33 quotes (schema.sql line 7481). REVOKE on default
-- privileges subtracts the two bits from the existing ACL entry rather than
-- replacing it, so future tables created by postgres in public arrive with
-- everything except TRUNCATE (D) and TRIGGER (t) for these two roles. The
-- postgres and service_role default grants are untouched.

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
    REVOKE TRUNCATE, TRIGGER ON TABLES FROM "anon", "authenticated";

-- ── 3. The shadow rule for supabase_admin, best-effort ─────────────────────────
--
-- pg_default_acl on the live databases carries a second, parallel
-- default-privileges entry FOR ROLE supabase_admin (the bootstrap superuser
-- on older Supabase projects) granting ALL on public tables to the same four
-- roles — invisible in schema.sql because pg_dump does not emit the bootstrap
-- superuser's ACLs. Nothing in this repo creates tables as supabase_admin,
-- but platform tooling might, and those tables would reacquire the revoked
-- bits through that entry.
--
-- Best-effort, guarded for two reasons: newer Supabase projects have removed
-- the role entirely (undefined_object), and a non-superuser may only alter
-- another role's default privileges as a member of it — postgres is not a
-- superuser here and is not a member of supabase_admin
-- (insufficient_privilege). Neither failure is this migration's to fix or
-- to die on.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
        ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public"
            REVOKE TRUNCATE, TRIGGER ON TABLES FROM "anon", "authenticated";
    END IF;
EXCEPTION
    WHEN insufficient_privilege OR undefined_object THEN
        NULL;
END
$$;
