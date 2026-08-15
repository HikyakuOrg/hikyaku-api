-- Ad-hoc, read-only. Dumps what's needed to extend the trial lockout into RLS
-- so direct PostgREST access is gated the same way hikyaku-api already is.
-- Nothing here writes; safe to run against any environment.

-- 1. Bodies of the RLS helper functions the policies call.
--    Needed verbatim because CREATE OR REPLACE has to restate the whole body --
--    retyping it from memory would silently drop conditions that are doing
--    tenant isolation work.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS security_definer,
       pg_get_functiondef(p.oid)                 AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
        'is_org_member',
        'is_personal_org_owner',
        'has_org_permission',
        'has_permission',
        'has_permission_for_driver',
        'package_org',
        'vehicle_folder_org',
        'maintenance_folder_org',
        'vrp_optimization_org',
        'vrp_solution_org',
        'driver_vehicle_same_org'
   )
 ORDER BY p.proname;

-- 2. Every RLS policy on the org-scoped tables, with its USING and WITH CHECK
--    clauses. This is what decides where the trial condition has to be added,
--    and -- just as importantly -- where it must NOT be.
--
--    Read the `organisations`, `team_members` and organisation_invitation* rows
--    first. Those must stay UNGATED: if an expired org stops being visible, it
--    disappears from listMyOrganisations() and the org switcher, and the
--    dashboard layout's `if (!currentOrg)` redirects to /orgs instead of
--    rendering the trial-ended dialog. The lockout has to leave the org readable
--    enough to explain itself.
SELECT schemaname,
       tablename,
       policyname,
       cmd,
       roles,
       qual        AS using_clause,
       with_check
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname;

-- 3. Which of those tables actually have RLS enabled and forced.
--    A table with policies but rls disabled is wide open regardless of what
--    section 2 says.
SELECT c.relname,
       c.relrowsecurity  AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
 ORDER BY c.relname;

-- 4. Views used by the dashboard. Views run with the *definer's* rights unless
--    declared security_invoker, in which case the underlying tables' RLS applies
--    to the caller. packages_with_latest_status is read directly by the frontend,
--    so which mode it uses decides whether gating the base table is enough.
SELECT c.relname,
       c.reloptions
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind IN ('v', 'm')
 ORDER BY c.relname;
