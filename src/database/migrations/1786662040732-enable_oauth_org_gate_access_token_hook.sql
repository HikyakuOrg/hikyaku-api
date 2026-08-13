-- Custom Access Token Hook: refuses to mint an access token for a third-party
-- OAuth client (Settings > Connected Apps in the web app) unless the user
-- belongs to a company organisation.
--
-- This is the server-side half of the personal-account gate already enforced
-- in app code (app/oauth/consent/page.tsx and submitOAuthDecision in
-- lib/actions/oauth.ts, hikyaku repo). Those checks run before Supabase
-- Auth's own /oauth/authorize approve step, which someone holding a valid
-- session token can reach directly via the Auth REST API, bypassing the app
-- entirely. That bypass can still get an approved grant and a short-lived
-- authorization code, but this hook fires again when the OAuth client
-- exchanges that code for an actual access token at /oauth/token, and
-- refuses to issue one for a personal account — so the bypass never yields a
-- working token.
--
-- Custom Access Token Hooks fire for every token Supabase Auth issues, not
-- just OAuth ones, so the gate only applies when claims.client_id is present
-- (Supabase sets it exclusively on OAuth-server-issued tokens); the user's
-- normal dashboard session tokens pass through untouched.
CREATE OR REPLACE FUNCTION "public"."gate_oauth_token_to_company_org"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  claims jsonb := event->'claims';
  oauth_client_id text := event->'claims'->>'client_id';
  uid uuid := (event->>'user_id')::uuid;
  has_company_org boolean;
begin
  if oauth_client_id is not null then
    select exists (
      select 1
      from public.team_members tm
      join public.organisations o on o.id = tm.organisation_id
      where tm.id = uid
        and o.org_type = 'company'
    ) into has_company_org;

    if not has_company_org then
      return jsonb_build_object(
        'error', jsonb_build_object(
          'http_code', 403,
          'message', 'OAuth apps can only be connected from an organisation account.'
        )
      );
    end if;
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

ALTER FUNCTION "public"."gate_oauth_token_to_company_org"("event" "jsonb") OWNER TO "postgres";

-- SECURITY DEFINER + owned by postgres (which already owns team_members and
-- organisations) means the function body reads those tables with the
-- owner's privileges — no grant on the tables themselves is needed, and
-- authenticated/anon keep exactly the table access their existing RLS
-- policies already give them.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which every role
-- (including authenticated/anon) inherits — so without the REVOKE below,
-- this would be callable directly via PostgREST as
-- POST /rest/v1/rpc/gate_oauth_token_to_company_org, letting anyone probe
-- any user_id's org membership. authenticated/anon never hold an explicit
-- grant of their own here, only the inherited PUBLIC one, so revoking from
-- PUBLIC is what actually removes their access; GRANT is additive and can't
-- narrow it back down. Only GoTrue (supabase_auth_admin) should be able to
-- call it.
REVOKE EXECUTE ON FUNCTION "public"."gate_oauth_token_to_company_org"("event" "jsonb") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."gate_oauth_token_to_company_org"("event" "jsonb") TO "supabase_auth_admin";
