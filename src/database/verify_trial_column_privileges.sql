-- Ad-hoc check, not a migration: confirms tenants cannot write trial_ends_at.
-- Safe to run anywhere — it reads catalogs only. Run it after
-- 1786771922600-AddOrganisationTrial has applied.

-- 1. Which columns `authenticated` may UPDATE.
--    EXPECT exactly two rows: name, org_type.
--    trial_ends_at appearing here means the column is writable and the trial can
--    be self-extended through PostgREST.
SELECT grantee, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public'
   AND table_name   = 'organisations'
   AND grantee      IN ('authenticated', 'anon')
   AND privilege_type = 'UPDATE'
 ORDER BY grantee, column_name;

-- 2. Table-level UPDATE must NOT be present for authenticated/anon.
--    A table-level grant subsumes the column list above and silently re-opens
--    every column, so EXPECT zero rows.
SELECT grantee, privilege_type
  FROM information_schema.table_privileges
 WHERE table_schema = 'public'
   AND table_name   = 'organisations'
   AND grantee      IN ('authenticated', 'anon')
   AND privilege_type = 'UPDATE';

-- 3. The insert trigger must exist and be enabled.
--    It is the only thing stopping a client supplying its own trial_ends_at on
--    INSERT, where the grant is still table-wide by design.
--    EXPECT one row, tgenabled = 'O' (enabled, origin).
SELECT tgname, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.organisations'::regclass
   AND NOT tgisinternal;

-- 4. End-to-end proof, as a real tenant rather than via the catalogs.
--    Run inside a transaction and roll back. EXPECT: "permission denied for
--    column trial_ends_at". If it instead reports 0 rows updated, the column
--    privilege is fine but RLS filtered the row — swap in an org id the user
--    actually administers to test the privilege itself.
--
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims = '{"sub":"<a-real-user-uuid>","role":"authenticated"}';
--   UPDATE public.organisations
--      SET trial_ends_at = now() + interval '10 years'
--    WHERE id = '<an-org-that-user-admins>';
-- ROLLBACK;
