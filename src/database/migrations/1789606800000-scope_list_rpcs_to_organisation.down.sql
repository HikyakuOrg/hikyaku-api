--
-- Reverse of 1789606800000-scope_list_rpcs_to_organisation.sql: drop the
-- organisation-scoped signatures, then restore the previous definitions
-- verbatim (from ExposeCoverageOutcomeOnPackageReads1788915600000 and
-- infra/db/schema.sql) so a revert leaves callers where they started.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

DROP FUNCTION IF EXISTS "public"."get_packages_with_latest_status"("p_organisation_id" "uuid", "p_statuses" "text"[], "p_limit" integer, "p_offset" integer, "p_coverage_outcomes" "text"[]);
DROP FUNCTION IF EXISTS "public"."get_packages_count"("p_organisation_id" "uuid", "p_statuses" "text"[], "p_coverage_outcomes" "text"[]);
DROP FUNCTION IF EXISTS "public"."get_team_members_paginated"("p_organisation_id" "uuid", "p_page" integer, "p_limit" integer, "p_search" "text");

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

CREATE FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid", "email" "text", "phone_number" "text", "display_name" "text", "avatar_url" "text", "role" "text", "email_confirmed_at" timestamp with time zone, "is_admin" boolean, "page_number" integer, "page_size" integer, "total" integer, "total_pages" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    safe_page int := greatest(p_page, 1);
    safe_limit int := least(greatest(p_limit, 1), 100);
    skip int := (safe_page - 1) * safe_limit;
    total_permissions int;
BEGIN
    SELECT count(*) INTO total_permissions FROM public.app_permission;

    -- Mirror of the team_members SELECT policy: managers (team_members.view)
    -- see everyone in their org, dispatchers (drivers.view) see only Driver
    -- members, everyone sees themselves. Multi-org callers get the union.
    RETURN QUERY
    WITH visible AS (
        SELECT
            tm.organisation_id,
            tm.id AS member_id,
            tm.role_id,
            tm.created_at
        FROM public.team_members tm
        JOIN public.team_members me
            ON me.organisation_id = tm.organisation_id
           AND me.id = (SELECT auth.uid())
        JOIN public.app_roles ar ON ar.id = tm.role_id
        WHERE public.has_org_permission(tm.organisation_id, 'team_members.view')
           OR (public.has_org_permission(tm.organisation_id, 'drivers.view') AND ar.name = 'Driver')
           OR tm.id = (SELECT auth.uid())
    ), matched AS (
        SELECT vm.*, u.email AS u_email, u.phone AS u_phone,
               u.raw_user_meta_data AS u_meta, u.email_confirmed_at AS u_confirmed
        FROM visible vm
        JOIN auth.users u ON u.id = vm.member_id
        WHERE p_search IS NULL
           OR u.email ILIKE '%' || p_search || '%'
           OR u.raw_user_meta_data->>'display_name' ILIKE '%' || p_search || '%'
    )
    SELECT
        m.member_id,
        m.u_email::text,
        m.u_phone::text AS phone_number,
        m.u_meta->>'display_name' AS display_name,
        m.u_meta->>'avatarUrl' AS avatar_url,
        ar.name AS role,
        m.u_confirmed,
        (
            SELECT COUNT(*) FROM public.user_permission up2
            WHERE up2.user_id = m.member_id
              AND up2.organisation_id = m.organisation_id
        ) = total_permissions AS is_admin,
        safe_page AS page_number,
        safe_limit AS page_size,
        (count(*) OVER ())::int AS total,
        ceil((count(*) OVER ())::numeric / safe_limit)::int AS total_pages
    FROM matched m
    JOIN public.app_roles ar ON ar.id = m.role_id
    ORDER BY m.created_at DESC
    OFFSET skip
    LIMIT safe_limit;
END;
$$;


ALTER FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text") OWNER TO "postgres";

GRANT ALL ON FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text") TO "service_role";
