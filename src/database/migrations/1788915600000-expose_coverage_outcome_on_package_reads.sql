--
-- Context: package_assignment.coverage_outcome (see
-- AddAssignmentCoverageOutcome1788829200000) is the only durable record of a
-- coverage decision, but the dashboard's two package-list reads never see it.
-- Both go through get_packages_with_latest_status / get_packages_count rather
-- than a plain PostgREST select, because both already assemble a "latest
-- status" via a LATERAL join that a bare select cannot express. Extending
-- those two functions is therefore the only way HIK-19 (fallback visibility in
-- the dashboard's packages list) can read the column at all.
--
-- DROP THEN CREATE, NOT "CREATE OR REPLACE", AND THAT IS DELIBERATE.
-- A function's identity in Postgres is (name, parameter TYPE list), so adding
-- a parameter does not replace the existing function, it creates a second,
-- overloaded one and leaves the three/one-argument original in the catalog.
-- PostgREST then has two candidates for any RPC call whose named JSON
-- parameters happen to satisfy both (every new parameter here has a default,
-- so most existing calls would) and refuses the call as ambiguous rather than
-- guessing. That would break both functions for every existing caller the
-- moment this migration ran, before a single line of application code
-- changed. Dropping the old signature first removes the ambiguity instead of
-- creating it; nothing else in schema.sql calls either function by name (the
-- only two entry points are the PostgREST RPC calls in
-- lib/supabase/supabase-rpc.ts), so there is nothing else to cascade onto.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── get_packages_with_latest_status ─────────────────────────────────────────
--
-- Adds the column via the existing package_assignment join (already present
-- for driver_id/driver_name, so this is not a new join) and a
-- p_coverage_outcomes filter that mirrors p_statuses: NULL means "no filter",
-- same convention, same position relative to the other filter argument.

DROP FUNCTION IF EXISTS "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer);

CREATE FUNCTION "public"."get_packages_with_latest_status"(
    "p_statuses" "text"[] DEFAULT NULL::"text"[],
    "p_limit" integer DEFAULT 50,
    "p_offset" integer DEFAULT 0,
    "p_coverage_outcomes" "text"[] DEFAULT NULL::"text"[]
) RETURNS TABLE(
    "id" "uuid",
    "tracking_number" "text",
    "created_at" timestamp with time zone,
    "from_customer" "uuid",
    "to_customer" "uuid",
    "from_customer_name" "text",
    "to_customer_name" "text",
    "from_customer_address" "text",
    "to_customer_address" "text",
    "latest_package_status_text" "text",
    "latest_package_status_at" timestamp with time zone,
    "driver_id" "uuid",
    "driver_name" "text",
    "coverage_outcome" "text"
)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.tracking_number,
        p.created_at,
        p.from_customer,
        p.to_customer,
        cf.customer_name::text AS from_customer_name,
        ct.customer_name::text AS to_customer_name,
        cf.customer_address AS from_customer_address,
        ct.customer_address AS to_customer_address,
        ps.status AS latest_package_status_text,
        pt_latest.created_at AS latest_package_status_at,
        au.id AS driver_id,
        au.raw_user_meta_data ->> 'display_name' AS driver_name,
        pa.coverage_outcome
    FROM public.packages p
    LEFT JOIN public.customer cf
        ON cf.id = p.from_customer
    LEFT JOIN public.customer ct
        ON ct.id = p.to_customer
    LEFT JOIN public.package_assignment pa
        ON pa.package_id = p.id
    LEFT JOIN auth.users au
        ON au.id = pa.driver_id
    LEFT JOIN LATERAL (
        SELECT pt.package_status, pt.created_at
        FROM public.package_timeline pt
        WHERE pt.package_id = p.id
        ORDER BY pt.created_at DESC, pt.id DESC
        LIMIT 1
    ) pt_latest ON true
    LEFT JOIN public.package_status ps
        ON ps.id = pt_latest.package_status
    WHERE public.has_org_permission(p.organisation_id, 'packages.view')
      AND (p_statuses IS NULL OR ps.enums = ANY(p_statuses))
      AND (p_coverage_outcomes IS NULL OR pa.coverage_outcome = ANY(p_coverage_outcomes))
    ORDER BY p.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

ALTER FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer, "p_coverage_outcomes" "text"[]) OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer, "p_coverage_outcomes" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer, "p_coverage_outcomes" "text"[]) TO "service_role";

-- ── get_packages_count ───────────────────────────────────────────────────────
--
-- Did not join package_assignment before; adds it only to support the same
-- filter, same NULL-means-no-filter convention as p_statuses right above it.

DROP FUNCTION IF EXISTS "public"."get_packages_count"("p_statuses" "text"[]);

CREATE FUNCTION "public"."get_packages_count"(
    "p_statuses" "text"[] DEFAULT NULL::"text"[],
    "p_coverage_outcomes" "text"[] DEFAULT NULL::"text"[]
) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
    v_count bigint;
BEGIN
    SELECT count(*) INTO v_count
    FROM (
        SELECT
            p.id,
            ps.enums AS latest_package_status_enum,
            pa.coverage_outcome
        FROM public.packages p
        LEFT JOIN public.package_assignment pa
            ON pa.package_id = p.id
        LEFT JOIN LATERAL (
            SELECT pt.package_status
            FROM public.package_timeline pt
            WHERE pt.package_id = p.id
            ORDER BY pt.created_at DESC, pt.id DESC
            LIMIT 1
        ) pt_latest ON true
        LEFT JOIN public.package_status ps
            ON ps.id = pt_latest.package_status
        WHERE public.has_org_permission(p.organisation_id, 'packages.view')
    ) t
    WHERE (
        p_statuses IS NULL
        OR t.latest_package_status_enum = ANY(p_statuses)
    )
    AND (
        p_coverage_outcomes IS NULL
        OR t.coverage_outcome = ANY(p_coverage_outcomes)
    );

    RETURN v_count;
END;
$$;

ALTER FUNCTION "public"."get_packages_count"("p_statuses" "text"[], "p_coverage_outcomes" "text"[]) OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."get_packages_count"("p_statuses" "text"[], "p_coverage_outcomes" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_packages_count"("p_statuses" "text"[], "p_coverage_outcomes" "text"[]) TO "service_role";
