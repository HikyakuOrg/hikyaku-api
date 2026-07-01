


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE SCHEMA IF NOT EXISTS "stripe";


ALTER SCHEMA "stripe" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "tzdata";


ALTER SCHEMA "tzdata" OWNER TO "postgres";


CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "hypopg" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "index_advisor" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgmq";






CREATE EXTENSION IF NOT EXISTS "postgis" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."broadcast_driver_location_to_tracking"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions', 'realtime'
    AS $$
DECLARE
    r record;
    v_payload jsonb;
BEGIN
    v_payload := jsonb_build_object(
        'lng', extensions.st_x(NEW.location::extensions.geometry),
        'lat', extensions.st_y(NEW.location::extensions.geometry),
        'updated_at', NEW.updated_at
    );

    FOR r IN
        SELECT p.tracking_number
        FROM public.package_assignment pa
        JOIN public.packages p ON p.id = pa.package_id
        JOIN LATERAL (
            SELECT ps.enums AS current_status
            FROM public.package_timeline pt
            JOIN public.package_status ps ON ps.id = pt.package_status
            WHERE pt.package_id = p.id
            ORDER BY pt.created_at DESC
            LIMIT 1
        ) latest ON true
        WHERE pa.driver_id = NEW.driver_id
          AND latest.current_status = 'IN_TRANSIT'
    LOOP
        PERFORM realtime.send(
            v_payload,                          -- payload
            'location',                         -- event
            'tracking:' || r.tracking_number,   -- topic
            true                                -- private
        );
    END LOOP;

    RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."broadcast_driver_location_to_tracking"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_vehicle_soft_deletion_rules"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    -- Only check rules if is_deleted is being set to true
    IF (NEW.is_deleted = true AND OLD.is_deleted = false) THEN
        -- Rule 1: Cannot delete if a driver is attached to the vehicle
        IF EXISTS (
            SELECT 1 FROM public.driver_vehicle_assignment 
            WHERE vehicle_id = OLD.id
        ) THEN
            RAISE EXCEPTION 'Cannot delete vehicle: active driver assignment exists.';
        END IF;

        -- Rule 2: Scheduled shift (future scheduled departure)
        IF EXISTS (
            SELECT 1 
            FROM public.package_assignment pa
            JOIN public.package_delivery_window pdw ON pa.package_id = pdw.package_id
            WHERE pa.vehicle_id = OLD.id 
            AND pdw.scheduled_departure > NOW()
            AND pdw.actual_departure IS NULL
        ) THEN
            RAISE EXCEPTION 'Cannot delete vehicle: it has a scheduled shift.';
        END IF;

        -- Rule 3: Ongoing shift (actual departure set, but no actual arrival)
        IF EXISTS (
            SELECT 1 
            FROM public.package_assignment pa
            JOIN public.package_delivery_window pdw ON pa.package_id = pdw.package_id
            WHERE pa.vehicle_id = OLD.id 
            AND pdw.actual_departure IS NOT NULL 
            AND pdw.actual_arrival IS NULL
        ) THEN
            RAISE EXCEPTION 'Cannot delete vehicle: it has an ongoing shift.';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_vehicle_soft_deletion_rules"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."driver_vehicle_same_org"("p_driver" "uuid", "p_vehicle" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.drivers d
        JOIN public.vehicles v ON v.organisation_id = d.organisation_id
        WHERE d.id = p_driver
          AND v.id = p_vehicle
    );
$$;


ALTER FUNCTION "public"."driver_vehicle_same_org"("p_driver" "uuid", "p_vehicle" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_driver_self_update_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF (SELECT auth.uid()) = OLD.id
       AND NOT public.has_org_permission(OLD.organisation_id, 'drivers.update') THEN
        IF NEW.id                     IS DISTINCT FROM OLD.id
           OR NEW.organisation_id     IS DISTINCT FROM OLD.organisation_id
           OR NEW.warehouse_id        IS DISTINCT FROM OLD.warehouse_id
           OR NEW.driver_under_probation IS DISTINCT FROM OLD.driver_under_probation THEN
            RAISE EXCEPTION 'drivers may only update their own licence details';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_driver_self_update_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_package_failed_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
    latest_status text;
BEGIN
    -- Get latest status of the package
    SELECT ps.status
    INTO latest_status
    FROM public.package_timeline pt
    JOIN public.package_status ps
        ON ps.id = pt.package_status
    WHERE pt.package_id = NEW.package_id
    ORDER BY pt.created_at DESC
    LIMIT 1;

    IF latest_status IS NULL THEN
        RAISE EXCEPTION 'Package % has no status history', NEW.package_id;
    END IF;

    IF latest_status <> 'FAILED' THEN
        RAISE EXCEPTION
            'Cannot insert failure record. Package % is currently in status %',
            NEW.package_id,
            latest_status;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_package_failed_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_same_warehouse"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
    driver_wh uuid;
    vehicle_wh uuid;
BEGIN
    SELECT warehouse_id INTO driver_wh
    FROM public.drivers
    WHERE id = NEW.driver_id;

    SELECT warehouse_id INTO vehicle_wh
    FROM public.vehicles
    WHERE id = NEW.vehicle_id;

    IF driver_wh IS NULL OR vehicle_wh IS NULL THEN
        RAISE EXCEPTION 'Driver or Vehicle not found';
    END IF;

    IF driver_wh <> vehicle_wh THEN
        RAISE EXCEPTION
        'Driver (%) and Vehicle (%) must belong to same warehouse',
        NEW.driver_id, NEW.vehicle_id;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_same_warehouse"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."folder_package_id"("p_name" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
    SELECT p.id
    FROM public.packages p
    WHERE p.id::text = (storage.foldername(p_name))[1];
$$;


ALTER FUNCTION "public"."folder_package_id"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_tracking_number"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'extensions'
    AS $$
BEGIN
  RETURN to_char(clock_timestamp(), 'YYMMDD') ||
         substr(
           encode(gen_random_bytes(8), 'base64'),
           1,
           11
         );
END;
$$;


ALTER FUNCTION "public"."generate_tracking_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_booking_organisation"("p_slug" "text") RETURNS TABLE("id" "uuid", "name" "text", "slug" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT o.id, o.name, o.slug
    FROM public.organisations o
    WHERE o.slug = p_slug;
$$;


ALTER FUNCTION "public"."get_booking_organisation"("p_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_driver_location_history"("p_driver_id" "uuid", "from_ts" timestamp with time zone, "to_ts" timestamp with time zone) RETURNS TABLE("id" "uuid", "driver_id" "uuid", "created_at" timestamp with time zone, "lat" double precision, "lng" double precision)
    LANGUAGE "sql"
    SET "search_path" TO 'public', 'extensions'
    AS $$
    select
        id,
        driver_id,
        created_at,
        ST_Y(location::geometry) as lat,
        ST_X(location::geometry) as lng
    from public.driver_location_history
    where driver_id = p_driver_id
      and created_at >= from_ts
      and created_at <= to_ts
    order by created_at desc;
$$;


ALTER FUNCTION "public"."get_driver_location_history"("p_driver_id" "uuid", "from_ts" timestamp with time zone, "to_ts" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_drivers_by_ids"("p_driver_ids" "uuid"[]) RETURNS TABLE("id" "uuid", "email" "text", "phone_number" "text", "display_name" "text", "avatar_url" "text", "driver_license" "text", "license_expiry" "date")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        u.email::text,
        u.phone::text AS phone_number,
        u.raw_user_meta_data->>'display_name' AS display_name,
        u.raw_user_meta_data->>'avatarUrl' AS avatar_url,
        d.driver_license,
        d.license_expiry
    FROM public.drivers d
    JOIN auth.users u ON u.id = d.id
    WHERE d.id = ANY(p_driver_ids)
      AND (
          public.has_org_permission(d.organisation_id, 'drivers.view')
          OR d.id = (SELECT auth.uid())
      )
    ORDER BY d.id DESC;
END;
$$;


ALTER FUNCTION "public"."get_drivers_by_ids"("p_driver_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_drivers_paginated"("p_page" integer, "p_limit" integer) RETURNS TABLE("id" "uuid", "email" "text", "phone_number" "text", "display_name" "text", "avatar_url" "text", "driver_license" "text", "license_expiry" "date", "page_number" integer, "page_size" integer, "total" integer, "total_pages" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    safe_page int := greatest(p_page, 1);
    safe_limit int := least(greatest(p_limit, 1), 100);
    skip int := (safe_page - 1) * safe_limit;
    total_count int;
BEGIN
    SELECT count(*) INTO total_count
    FROM public.drivers d
    WHERE public.has_org_permission(d.organisation_id, 'drivers.view')
       OR d.id = (SELECT auth.uid());

    RETURN QUERY
    SELECT
        d.id,
        u.email::text,
        u.phone::text AS phone_number,
        u.raw_user_meta_data->>'display_name' AS display_name,
        u.raw_user_meta_data->>'avatarUrl' AS avatar_url,
        d.driver_license,
        d.license_expiry,
        safe_page AS page_number,
        safe_limit AS page_size,
        total_count AS total,
        ceil(total_count::numeric / safe_limit)::int AS total_pages
    FROM public.drivers d
    JOIN auth.users u ON u.id = d.id
    WHERE public.has_org_permission(d.organisation_id, 'drivers.view')
       OR d.id = (SELECT auth.uid())
    ORDER BY d.id DESC
    OFFSET skip
    LIMIT safe_limit;
END;
$$;


ALTER FUNCTION "public"."get_drivers_paginated"("p_page" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_optimisation_list"("p_limit" integer DEFAULT 20, "p_page" integer DEFAULT 1) RETURNS TABLE("id" "uuid", "created_at" timestamp with time zone, "status" "text", "routes" integer, "packages_assigned" integer, "unassigned" integer, "total_duration_seconds" integer, "total_duration_hours" numeric, "cost" integer, "avg_route_duration_seconds" numeric, "avg_route_duration_hours" numeric, "max_route_duration_seconds" integer, "avg_stops_per_route" numeric, "total_count" bigint)
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
    with base as (
        select
            s.id,
            s.created_at,

            case
                when s.unassigned_count > 0 then 'Partial'
                else 'Success'
            end as status,

            s.routes_count as routes,
            coalesce(s.delivery[1], 0) as packages_assigned,
            s.unassigned_count as unassigned,

            s.duration as total_duration_seconds,
            (s.duration / 3600.0)::numeric(10,2) as total_duration_hours,

            s.cost,

            avg(r.duration) as avg_route_duration_seconds,
            (avg(r.duration) / 3600.0)::numeric(10,2) as avg_route_duration_hours,

            max(r.duration) as max_route_duration_seconds,

            avg(route_stats.stops) as avg_stops_per_route

        from vrp_solution s
        left join vrp_route r
            on r.solution_id = s.id

        left join (
            select
                route_id,
                count(*) filter (where type = 'job') as stops
            from vrp_route_step
            group by route_id
        ) route_stats
            on route_stats.route_id = r.id

        group by s.id
    )

    select
        *,
        count(*) over() as total_count
    from base
    order by created_at desc
    limit p_limit
    offset (p_page - 1) * p_limit;
$$;


ALTER FUNCTION "public"."get_optimisation_list"("p_limit" integer, "p_page" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) RETURNS bigint
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
            ps.enums AS latest_package_status_enum
        FROM public.packages p
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
    );

    RETURN v_count;
END;
$$;


ALTER FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[] DEFAULT NULL::"text"[], "p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "tracking_number" "text", "created_at" timestamp with time zone, "from_customer" "uuid", "to_customer" "uuid", "from_customer_name" "text", "to_customer_name" "text", "from_customer_address" "text", "to_customer_address" "text", "latest_package_status_text" "text", "latest_package_status_at" timestamp with time zone, "driver_id" "uuid", "driver_name" "text")
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
        au.raw_user_meta_data ->> 'display_name' AS driver_name
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
    ORDER BY p.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;


ALTER FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_service_area_extent"() RETURNS TABLE("min_lng" double precision, "min_lat" double precision, "max_lng" double precision, "max_lat" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
    SELECT
        ST_XMin(extent) AS min_lng,
        ST_YMin(extent) AS min_lat,
        ST_XMax(extent) AS max_lng,
        ST_YMax(extent) AS max_lat
    FROM (
        SELECT ST_Extent(geometry)::extensions.box2d AS extent
        FROM public.service_areas
    ) AS service_area_extent
    WHERE extent IS NOT NULL;
$$;


ALTER FUNCTION "public"."get_service_area_extent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) RETURNS TABLE("id" "uuid", "name" "text", "geometry" json)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'extensions'
    AS $$
    SELECT
        sa.id,
        sa.name,
        ST_AsGeoJSON(sa.geometry)::json AS geometry
    FROM public.service_areas AS sa
    WHERE sa.geometry && ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)
      AND ST_Intersects(sa.geometry, ST_MakeEnvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326))
    ORDER BY sa.name ASC;
$$;


ALTER FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text" DEFAULT NULL::"text") RETURNS TABLE("id" "uuid", "email" "text", "phone_number" "text", "display_name" "text", "avatar_url" "text", "role" "text", "email_confirmed_at" timestamp with time zone, "is_admin" boolean, "page_number" integer, "page_size" integer, "total" integer, "total_pages" integer)
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


CREATE OR REPLACE FUNCTION "public"."get_tracking_details"("p_tracking_number" "text", "p_slug" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
    v_result jsonb;  -- not `v`: vehicles is aliased `v` in a subquery below
BEGIN
    SELECT jsonb_build_object(
        'package_id', p.id,
        'tracking_number', p.tracking_number,
        'current_status', latest.current_status,
        'created_at', p.created_at,
        'delivery_notes', p.delivery_notes,
        'recipient', jsonb_build_object(
            'name', c.customer_name,
            'email', c.customer_email,
            'address', c.customer_address,
            'lng', extensions.st_x(c.customer_location::extensions.geometry),
            'lat', extensions.st_y(c.customer_location::extensions.geometry)
        ),
        'origin', CASE WHEN w.id IS NOT NULL THEN jsonb_build_object(
            'name', w.warehouse_name,
            'lng', extensions.st_x(w.warehouse_location::extensions.geometry),
            'lat', extensions.st_y(w.warehouse_location::extensions.geometry)
        ) END,
        'timeline', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object('status', ps.enums, 'created_at', pt.created_at)
                ORDER BY pt.created_at
            )
            FROM public.package_timeline pt
            JOIN public.package_status ps ON ps.id = pt.package_status
            WHERE pt.package_id = p.id
        ), '[]'::jsonb),
        'driver', CASE WHEN latest.current_status = 'IN_TRANSIT' THEN (
            SELECT jsonb_build_object(
                'name', u.raw_user_meta_data->>'display_name',
                'vehicle_type', vt.vehicle_type,
                -- plate + make/model are meaningful only for non-bicycle vehicles
                'vehicle_plate', CASE WHEN vt.vehicle_type <> 'Bicycle' THEN v.vehicle_plate END,
                'vehicle_label', CASE WHEN vt.vehicle_type <> 'Bicycle'
                    THEN nullif(btrim(concat_ws(' ', v.vehicle_make, v.vehicle_model)), '') END
            )
            FROM public.package_assignment pa
            JOIN auth.users u ON u.id = pa.driver_id
            LEFT JOIN public.vehicles v ON v.id = pa.vehicle_id
            LEFT JOIN public.vehicle_type vt ON vt.id = v.vehicle_type
            WHERE pa.package_id = p.id
        ) END,
        'driver_location', CASE WHEN latest.current_status = 'IN_TRANSIT' THEN (
            SELECT jsonb_build_object(
                'lng', extensions.st_x(dcl.location::extensions.geometry),
                'lat', extensions.st_y(dcl.location::extensions.geometry),
                'updated_at', dcl.updated_at
            )
            FROM public.package_assignment pa
            JOIN public.driver_current_location dcl ON dcl.driver_id = pa.driver_id
            WHERE pa.package_id = p.id
        ) END
    )
    INTO v_result
    FROM public.packages p
    JOIN public.customer c ON c.id = p.to_customer
    JOIN public.organisations o ON o.id = p.organisation_id AND o.slug = p_slug
    LEFT JOIN public.warehouse w ON w.id = p.warehouse_id
    JOIN LATERAL (
        SELECT ps.enums AS current_status
        FROM public.package_timeline pt
        JOIN public.package_status ps ON ps.id = pt.package_status
        WHERE pt.package_id = p.id
        ORDER BY pt.created_at DESC
        LIMIT 1
    ) latest ON true
    WHERE p.tracking_number = p_tracking_number;

    RETURN v_result;  -- NULL when not found / wrong org
END;
$$;


ALTER FUNCTION "public"."get_tracking_details"("p_tracking_number" "text", "p_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_organisation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_role_id bigint;
begin
  -- Calling user
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'handle_new_organisation: auth.uid() is null (are you inserting with an authenticated session?)';
  end if;

  -- Admin role id (app_roles.id is bigint in your schema)
  select id
    into v_role_id
  from public.app_roles
  where name = 'Admin'
  limit 1;

  if v_role_id is null then
    raise exception 'handle_new_organisation: app_roles row for name="Admin" not found';
  end if;

  -- Grant every permission to the creator, scoped to the new org.
  insert into public.user_permission (organisation_id, user_id, permission_id)
  select new.id, v_user_id, ap.id
  from public.app_permission ap
  on conflict do nothing;

  -- Add caller as Admin member of the new org.
  insert into public.team_members (organisation_id, id, role_id)
  values (new.id, v_user_id, v_role_id)
  on conflict do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_organisation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_vehicle_storage_cleanup_soft"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
BEGIN
    -- If is_deleted is being set to true, clean up storage
    IF (NEW.is_deleted = true AND OLD.is_deleted = false) THEN
        DELETE FROM storage.objects 
        WHERE bucket_id = 'vehicles' 
        AND name LIKE OLD.id || '/%';
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_vehicle_storage_cleanup_soft"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_org_permission"("p_org" "uuid", "p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_permission up
        JOIN public.app_permission ap ON ap.id = up.permission_id
        WHERE up.organisation_id = p_org
          AND up.user_id = (SELECT auth.uid())
          AND ap.permission = p_permission
    )
    OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.role_permission rp ON rp.role_id = tm.role_id
        JOIN public.app_permission ap ON ap.id = rp.permission_id
        WHERE tm.organisation_id = p_org
          AND tm.id = (SELECT auth.uid())
          AND ap.permission = p_permission
    );
$$;


ALTER FUNCTION "public"."has_org_permission"("p_org" "uuid", "p_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_permission"("p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_permission up
        JOIN public.app_permission p ON p.id = up.permission_id
        WHERE up.user_id = (SELECT auth.uid())
          AND p.permission = p_permission
    )
    OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.role_permission rp ON rp.role_id = tm.role_id
        JOIN public.app_permission ap ON ap.id = rp.permission_id
        WHERE tm.id = (SELECT auth.uid())
          AND ap.permission = p_permission
    );
$$;


ALTER FUNCTION "public"."has_permission"("p_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_permission_for_driver"("p_driver" "uuid", "p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.drivers d
        WHERE d.id = p_driver
          AND public.has_org_permission(d.organisation_id, p_permission)
    );
$$;


ALTER FUNCTION "public"."has_permission_for_driver"("p_driver" "uuid", "p_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."insert_package_timeline"("p_package_id" "uuid", "p_status_enum" "text") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
insert into package_timeline (package_id, package_status)
select p_package_id, id
from package_status
where enums = p_status_enum
on conflict (package_id, package_status) do nothing;
$$;


ALTER FUNCTION "public"."insert_package_timeline"("p_package_id" "uuid", "p_status_enum" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_assigned_driver"("p_package_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.package_assignment pa
        WHERE pa.package_id = p_package_id
          AND pa.driver_id = (SELECT auth.uid())
    );
$$;


ALTER FUNCTION "public"."is_assigned_driver"("p_package_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_optimization_driver"("p_opt_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.vrp_solution s
        JOIN public.vrp_route_step st ON st.solution_id = s.id
        JOIN public.package_assignment pa ON pa.package_id = st.package_id
        WHERE s.optimization_id = p_opt_id
          AND pa.driver_id = (SELECT auth.uid())
    );
$$;


ALTER FUNCTION "public"."is_optimization_driver"("p_opt_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_org_member"("p_org" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.team_members tm
        WHERE tm.organisation_id = p_org
          AND tm.id = (SELECT auth.uid())
    );
$$;


ALTER FUNCTION "public"."is_org_member"("p_org" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_personal_org_owner"("p_org" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.organisations o
    where o.id = p_org
      and o.org_type = 'personal'
      and o.created_by = (select auth.uid())
  );
$$;


ALTER FUNCTION "public"."is_personal_org_owner"("p_org" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_route_driver"("p_route_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.vrp_route_step st
        JOIN public.package_assignment pa ON pa.package_id = st.package_id
        WHERE st.route_id = p_route_id
          AND pa.driver_id = (SELECT auth.uid())
    );
$$;


ALTER FUNCTION "public"."is_route_driver"("p_route_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_solution_driver"("p_solution_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.vrp_route_step st
        JOIN public.package_assignment pa ON pa.package_id = st.package_id
        WHERE st.solution_id = p_solution_id
          AND pa.driver_id = (SELECT auth.uid())
    );
$$;


ALTER FUNCTION "public"."is_solution_driver"("p_solution_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_tracking_topic_in_transit"("p_topic" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.packages p
        JOIN LATERAL (
            SELECT ps.enums AS current_status
            FROM public.package_timeline pt
            JOIN public.package_status ps ON ps.id = pt.package_status
            WHERE pt.package_id = p.id
            ORDER BY pt.created_at DESC
            LIMIT 1
        ) latest ON true
        WHERE 'tracking:' || p.tracking_number = p_topic
          AND latest.current_status = 'IN_TRANSIT'
    );
$$;


ALTER FUNCTION "public"."is_tracking_topic_in_transit"("p_topic" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_drivers_by_warehouse"("p_warehouse_id" "uuid", "p_page" integer, "p_limit" integer) RETURNS TABLE("id" "uuid", "email" "text", "phone_number" "text", "display_name" "text", "avatar_url" "text", "driver_license" "text", "license_expiry" "date", "warehouse_id" "uuid", "vehicle_id" "uuid", "vehicle_plate" "text", "vehicle_make" "text", "vehicle_model" "text", "page_number" integer, "page_size" integer, "total" integer, "total_pages" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    safe_page int := greatest(p_page, 1);
    safe_limit int := least(greatest(p_limit, 1), 100);
    skip int := (safe_page - 1) * safe_limit;
    total_count int;
BEGIN
    SELECT count(*) INTO total_count
    FROM public.drivers d
    WHERE d.warehouse_id = p_warehouse_id
      AND (
          public.has_org_permission(d.organisation_id, 'drivers.view')
          OR d.id = (SELECT auth.uid())
      );

    RETURN QUERY
    SELECT
        d.id,
        u.email::text,
        u.phone::text AS phone_number,
        u.raw_user_meta_data->>'display_name' AS display_name,
        u.raw_user_meta_data->>'avatarUrl' AS avatar_url,
        d.driver_license,
        d.license_expiry,
        d.warehouse_id,
        v.id AS vehicle_id,
        v.vehicle_plate,
        v.vehicle_make,
        v.vehicle_model,
        safe_page AS page_number,
        safe_limit AS page_size,
        total_count AS total,
        ceil(total_count::numeric / safe_limit)::int AS total_pages
    FROM public.drivers d
    JOIN auth.users u ON u.id = d.id
    LEFT JOIN public.driver_vehicle_assignment dva
        ON dva.driver_id = d.id
    LEFT JOIN public.vehicles v
        ON v.id = dva.vehicle_id
    WHERE d.warehouse_id = p_warehouse_id
      AND (
          public.has_org_permission(d.organisation_id, 'drivers.view')
          OR d.id = (SELECT auth.uid())
      )
    ORDER BY d.id DESC
    OFFSET skip
    LIMIT safe_limit;
END;
$$;


ALTER FUNCTION "public"."list_drivers_by_warehouse"("p_warehouse_id" "uuid", "p_page" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_unassigned_drivers"("p_page" integer, "p_limit" integer) RETURNS TABLE("id" "uuid", "email" "text", "phone_number" "text", "display_name" "text", "avatar_url" "text", "driver_license" "text", "license_expiry" "date", "page_number" integer, "page_size" integer, "total" integer, "total_pages" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
    safe_page int := greatest(p_page, 1);
    safe_limit int := least(greatest(p_limit, 1), 100);
    skip int := (safe_page - 1) * safe_limit;
    total_count int;
BEGIN
    SELECT count(*) INTO total_count
    FROM public.drivers d
    WHERE d.warehouse_id IS NULL
      AND (
          public.has_org_permission(d.organisation_id, 'drivers.view')
          OR d.id = (SELECT auth.uid())
      );

    RETURN QUERY
    SELECT
        d.id,
        u.email::text,
        u.phone::text AS phone_number,
        u.raw_user_meta_data->>'display_name' AS display_name,
        u.raw_user_meta_data->>'avatarUrl' AS avatar_url,
        d.driver_license,
        d.license_expiry,
        safe_page AS page_number,
        safe_limit AS page_size,
        total_count AS total,
        ceil(total_count::numeric / safe_limit)::int AS total_pages
    FROM public.drivers d
    JOIN auth.users u ON u.id = d.id
    WHERE d.warehouse_id IS NULL
      AND (
          public.has_org_permission(d.organisation_id, 'drivers.view')
          OR d.id = (SELECT auth.uid())
      )
    ORDER BY d.id DESC
    OFFSET skip
    LIMIT safe_limit;
END;
$$;


ALTER FUNCTION "public"."list_unassigned_drivers"("p_page" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_driver_location_history"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if TG_OP = 'INSERT'
     or (TG_OP = 'UPDATE' and NEW.location is distinct from OLD.location)
  then
    insert into public.driver_location_history (
      driver_id,
      location,
      created_at
    )
    values (
      NEW.driver_id,
      NEW.location,
      now()
    );
  end if;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."log_driver_location_history"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."maintenance_folder_org"("p_name" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
    SELECT m.organisation_id
    FROM public.vehicle_maintenance m
    WHERE m.id::text = (storage.foldername(p_name))[1];
$$;


ALTER FUNCTION "public"."maintenance_folder_org"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."member_role_name"("p_org" "uuid", "p_user" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT r.name
    FROM public.team_members tm
    JOIN public.app_roles r ON r.id = tm.role_id
    WHERE tm.organisation_id = p_org
      AND tm.id = p_user;
$$;


ALTER FUNCTION "public"."member_role_name"("p_org" "uuid", "p_user" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."package_folder_is_delivered"("p_name" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.packages p
        JOIN LATERAL (
            SELECT ps.enums AS current_status
            FROM public.package_timeline pt
            JOIN public.package_status ps ON ps.id = pt.package_status
            WHERE pt.package_id = p.id
            ORDER BY pt.created_at DESC
            LIMIT 1
        ) latest ON true
        WHERE p.id::text = (storage.foldername(p_name))[1]
          AND latest.current_status = 'DELIVERED'
    );
$$;


ALTER FUNCTION "public"."package_folder_is_delivered"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."package_latest_status"("p_package_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT ps.enums
    FROM public.package_timeline pt
    JOIN public.package_status ps ON ps.id = pt.package_status
    WHERE pt.package_id = p_package_id
    ORDER BY pt.created_at DESC, pt.id DESC
    LIMIT 1;
$$;


ALTER FUNCTION "public"."package_latest_status"("p_package_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."package_org"("p_package_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT p.organisation_id
    FROM public.packages p
    WHERE p.id = p_package_id;
$$;


ALTER FUNCTION "public"."package_org"("p_package_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_driver_move_if_assigned"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.driver_vehicle_assignment
        WHERE driver_id = NEW.id
    ) THEN
        RAISE EXCEPTION
        'Cannot move driver (%) to another warehouse while actively assigned',
        NEW.id;
    END IF;

    RETURN NEW;
END;$$;


ALTER FUNCTION "public"."prevent_driver_move_if_assigned"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_manual_status_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF OLD.current_status_id IS DISTINCT FROM NEW.current_status_id THEN
        RAISE EXCEPTION 'current_status_id cannot be updated directly';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_manual_status_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_vehicle_move_if_assigned"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.driver_vehicle_assignment
        WHERE vehicle_id = NEW.id
    ) THEN
        RAISE EXCEPTION
        'Cannot move vehicle (%) to another warehouse while actively assigned',
        NEW.id;
    END IF;

    RETURN NEW;
END;$$;


ALTER FUNCTION "public"."prevent_vehicle_move_if_assigned"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_tracking_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'extensions'
    AS $$
begin
    if new.tracking_number is null then
        new.tracking_number := generate_tracking_number();
    end if;

    return new;
end;
$$;


ALTER FUNCTION "public"."set_tracking_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_driver_profile"("p_driver_id" "uuid", "p_driver_license" "text" DEFAULT NULL::"text", "p_license_expiry" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_vehicle_type" "uuid" DEFAULT NULL::"uuid", "p_email" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_display_name" "text" DEFAULT NULL::"text", "p_avatar_url" "text" DEFAULT NULL::"text") RETURNS json
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
    v_org uuid;
    result json;
begin
    select d.organisation_id into v_org
    from public.drivers d
    where d.id = p_driver_id;

    if v_org is null then
        raise exception 'Driver not found';
    end if;

    if not (
        public.has_org_permission(v_org, 'drivers.update')
        or p_driver_id = (select auth.uid())
    ) then
        raise exception 'Insufficient permissions';
    end if;

    if p_vehicle_type is not null then
        perform 1 from public.vehicle_type where id = p_vehicle_type;
        if not found then
            raise exception 'Invalid vehicle_type id: %', p_vehicle_type;
        end if;
    end if;

    update public.drivers
    set
        driver_license = coalesce(p_driver_license, driver_license),
        license_expiry = coalesce(p_license_expiry, license_expiry),
        license_type = coalesce(p_vehicle_type, license_type)
    where id = p_driver_id;

    update auth.users
    set
        email = coalesce(p_email, email),
        phone = coalesce(p_phone, phone),
        raw_user_meta_data = jsonb_set(
            jsonb_set(
                coalesce(raw_user_meta_data, '{}'::jsonb),
                '{display_name}',
                to_jsonb(coalesce(p_display_name, raw_user_meta_data->>'display_name'))
            ),
            '{avatarUrl}',
            to_jsonb(coalesce(p_avatar_url, raw_user_meta_data->>'avatarUrl'))
        )
    where id = p_driver_id;

    select json_build_object(
        'id', d.id,
        'driverLicense', d.driver_license,
        'licenseExpiry', d.license_expiry,
        'vehicleType', json_build_object(
            'id', vt.id,
            'type', vt.vehicle_type
        ),
        'email', u.email,
        'phoneNumber', u.phone,
        'displayName', u.raw_user_meta_data->>'display_name',
        'avatarUrl', u.raw_user_meta_data->>'avatarUrl'
    )
    into result
    from public.drivers d
    join auth.users u on u.id = d.id
    left join public.vehicle_type vt on vt.id = d.license_type
    where d.id = p_driver_id;

    return result;
end;
$$;


ALTER FUNCTION "public"."update_driver_profile"("p_driver_id" "uuid", "p_driver_license" "text", "p_license_expiry" timestamp with time zone, "p_vehicle_type" "uuid", "p_email" "text", "p_phone" "text", "p_display_name" "text", "p_avatar_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_driver_vehicle_warehouse"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  driver_wh uuid;
  vehicle_wh uuid;
begin

  select warehouse_id
  into driver_wh
  from drivers
  where id = new.driver_id;

  select warehouse_id
  into vehicle_wh
  from vehicles
  where id = new.vehicle_id;

  if driver_wh is distinct from vehicle_wh then
    raise exception
    'Driver and vehicle must belong to same warehouse';
  end if;

  return new;

end;
$$;


ALTER FUNCTION "public"."validate_driver_vehicle_warehouse"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vehicle_folder_org"("p_name" "text") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage'
    AS $$
    SELECT v.organisation_id
    FROM public.vehicles v
    WHERE v.id::text = (storage.foldername(p_name))[1];
$$;


ALTER FUNCTION "public"."vehicle_folder_org"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vrp_optimization_org"("p_opt_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT COALESCE(
        (SELECT o.organisation_id FROM public.vrp_optimization o WHERE o.id = p_opt_id),
        (SELECT p.organisation_id FROM public.packages p WHERE p.optimisation_id = p_opt_id LIMIT 1)
    );
$$;


ALTER FUNCTION "public"."vrp_optimization_org"("p_opt_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vrp_solution_org"("p_solution_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT public.vrp_optimization_org(s.optimization_id)
    FROM public.vrp_solution s
    WHERE s.id = p_solution_id;
$$;


ALTER FUNCTION "public"."vrp_solution_org"("p_solution_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."app_permission" (
    "id" bigint NOT NULL,
    "permission" "text" NOT NULL
);


ALTER TABLE "public"."app_permission" OWNER TO "postgres";


ALTER TABLE "public"."app_permission" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."app_permission_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."app_roles" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL
);


ALTER TABLE "public"."app_roles" OWNER TO "postgres";


ALTER TABLE "public"."app_roles" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."app_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."customer" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_location" "extensions"."geometry" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    "stripe_customer_id" "text",
    "customer_name" "extensions"."citext",
    "customer_phone" "text",
    "customer_email" "extensions"."citext",
    "customer_address" "text",
    "customer_suburb" "text",
    "customer_state" "text",
    "customer_postcode" "text",
    "customer_country" "text",
    "geocode_confidence" numeric,
    "pelias_gid" "text",
    "pelias_raw" "jsonb",
    CONSTRAINT "customer_phone_e164_check" CHECK ((("customer_phone" IS NULL) OR ("customer_phone" ~ '^\+[1-9][0-9]{1,14}$'::"text")))
);


ALTER TABLE "public"."customer" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."driver_current_location" (
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "location" "extensions"."geometry" NOT NULL,
    "speed" numeric NOT NULL
);


ALTER TABLE "public"."driver_current_location" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."driver_location_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "location" "extensions"."geometry" NOT NULL
);


ALTER TABLE "public"."driver_location_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."driver_vehicle_assignment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "vehicle_id" "uuid" NOT NULL,
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."driver_vehicle_assignment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drivers" (
    "id" "uuid" NOT NULL,
    "driver_license" "text",
    "license_expiry" "date",
    "warehouse_id" "uuid",
    "country_of_issue" "text",
    "driver_under_probation" boolean,
    "license_type" "uuid",
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."drivers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organisation_invitation_permissions" (
    "invitation_id" "uuid" NOT NULL,
    "permission_id" bigint NOT NULL
);


ALTER TABLE "public"."organisation_invitation_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organisation_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role_id" bigint NOT NULL,
    "invited_by_user_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    CONSTRAINT "organisation_invitations_email_lower_check" CHECK (("email" = "lower"("email"))),
    CONSTRAINT "organisation_invitations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."organisation_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organisations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" DEFAULT "lower"(SUBSTRING(("md5"(("gen_random_uuid"())::"text") || "md5"(("gen_random_uuid"())::"text")) FROM 1 FOR 20)) NOT NULL,
    "name" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "org_type" "text" DEFAULT 'personal'::"text" NOT NULL,
    CONSTRAINT "organisations_slug_format_check" CHECK (("slug" ~ '^[a-z0-9]{6,20}$'::"text"))
);


ALTER TABLE "public"."organisations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."package_assignment" (
    "package_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "vehicle_id" "uuid" NOT NULL
);


ALTER TABLE "public"."package_assignment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."package_delivery_window" (
    "package_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scheduled_departure" timestamp with time zone,
    "actual_departure" timestamp with time zone,
    "scheduled_arrival" timestamp with time zone,
    "actual_arrival" timestamp with time zone
);


ALTER TABLE "public"."package_delivery_window" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."package_dimensions" (
    "package_id" "uuid" NOT NULL,
    "weight_kg" numeric NOT NULL,
    "length_cm" numeric NOT NULL,
    "width_cm" numeric NOT NULL,
    "height_cm" numeric NOT NULL
);


ALTER TABLE "public"."package_dimensions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."package_failure" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "package_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "failure_reason" "text" NOT NULL
);


ALTER TABLE "public"."package_failure" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."package_proof_of_delivery" (
    "id" bigint NOT NULL,
    "package_id" "uuid" NOT NULL,
    "pod_type_id" bigint NOT NULL,
    "file_url" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "location" "extensions"."geography"(Point,4326)
);


ALTER TABLE "public"."package_proof_of_delivery" OWNER TO "postgres";


ALTER TABLE "public"."package_proof_of_delivery" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."package_proof_of_delivery_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."package_status" (
    "id" bigint NOT NULL,
    "status" "text" NOT NULL,
    "enums" "text" NOT NULL
);


ALTER TABLE "public"."package_status" OWNER TO "postgres";


ALTER TABLE "public"."package_status" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."package_status_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."package_timeline" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "package_id" "uuid" NOT NULL,
    "package_status" bigint NOT NULL
);


ALTER TABLE "public"."package_timeline" OWNER TO "postgres";


ALTER TABLE "public"."package_timeline" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."package_timeline_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivery_notes" "text",
    "from_customer" "uuid" NOT NULL,
    "to_customer" "uuid" NOT NULL,
    "warehouse_id" "uuid",
    "tracking_number" "text" NOT NULL,
    "optimisation_id" "uuid",
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."packages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."warehouse" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "warehouse_name" "text" NOT NULL,
    "warehouse_address" "text" NOT NULL,
    "warehouse_location" "extensions"."geometry" NOT NULL,
    "warehouse_country" "text" NOT NULL,
    "warehouse_zipcode" "text" NOT NULL,
    "warehouse_state" "text" NOT NULL,
    "warehouse_city" "text" NOT NULL,
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."warehouse" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."packages_with_latest_status" WITH ("security_invoker"='on') AS
 SELECT "p"."id",
    "p"."created_at",
    "p"."delivery_notes",
    "p"."from_customer",
    "p"."to_customer",
    "p"."warehouse_id",
    "ps"."enums" AS "current_status",
    "w"."warehouse_name",
    "w"."warehouse_address",
    "extensions"."st_y"("w"."warehouse_location") AS "warehouse_lat",
    "extensions"."st_x"("w"."warehouse_location") AS "warehouse_lng"
   FROM ((("public"."packages" "p"
     JOIN ( SELECT DISTINCT ON ("pt"."package_id") "pt"."package_id",
            "pt"."package_status"
           FROM "public"."package_timeline" "pt"
          ORDER BY "pt"."package_id", "pt"."created_at" DESC) "latest" ON (("latest"."package_id" = "p"."id")))
     JOIN "public"."package_status" "ps" ON (("ps"."id" = "latest"."package_status")))
     LEFT JOIN "public"."warehouse" "w" ON (("w"."id" = "p"."warehouse_id")));


ALTER VIEW "public"."packages_with_latest_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pod_type" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "description" "text"
);


ALTER TABLE "public"."pod_type" OWNER TO "postgres";


ALTER TABLE "public"."pod_type" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."pod_type_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."role_permission" (
    "role_id" bigint NOT NULL,
    "permission_id" bigint NOT NULL
);


ALTER TABLE "public"."role_permission" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scheduler_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "warehouse_id" "uuid" NOT NULL,
    "run_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."scheduler_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_areas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "geometry" "extensions"."geometry"(Polygon,4326) NOT NULL,
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."service_areas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_members" (
    "id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role_id" bigint NOT NULL,
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."team_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_permission" (
    "user_id" "uuid" NOT NULL,
    "permission_id" bigint NOT NULL,
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "public"."user_permission" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vehicle_maintenance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    "vehicle_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "odometer" numeric NOT NULL,
    "description" "text" NOT NULL,
    "date_serviced" "date" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vehicle_maintenance_odometer_check" CHECK (("odometer" >= (0)::numeric))
);


ALTER TABLE "public"."vehicle_maintenance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vehicle_type" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vehicle_type" "text" NOT NULL,
    "vehicle_description" "text",
    "ors_vehicle_type" "text" NOT NULL,
    "valhalla_vehicle_type" "text" NOT NULL
);


ALTER TABLE "public"."vehicle_type" OWNER TO "postgres";


COMMENT ON COLUMN "public"."vehicle_type"."valhalla_vehicle_type" IS 'Vehicle Types can be found here: https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/#costing-models';



CREATE TABLE IF NOT EXISTS "public"."vehicles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vehicle_plate" "text",
    "vehicle_identification_number" "text",
    "vehicle_make" "text",
    "vehicle_year" numeric NOT NULL,
    "vehicle_model" "text",
    "vehicle_type" "uuid" NOT NULL,
    "vehicle_gross_limits" numeric NOT NULL,
    "warehouse_id" "uuid",
    "is_deleted" boolean DEFAULT false NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    CONSTRAINT "vehicles_vehicle_gross_limits_check" CHECK (("vehicle_gross_limits" > (0)::numeric))
);


ALTER TABLE "public"."vehicles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vrp_optimization" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "provider" "text" NOT NULL,
    "request" "jsonb" NOT NULL,
    "response" "jsonb" NOT NULL,
    "organisation_id" "uuid",
    "scheduled_start" timestamp with time zone
);


ALTER TABLE "public"."vrp_optimization" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vrp_route" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "solution_id" "uuid" NOT NULL,
    "cost" integer,
    "delivery" integer[],
    "amount" integer[],
    "pickup" integer[],
    "setup" integer,
    "service" integer,
    "duration" integer,
    "waiting_time" integer,
    "priority" integer
);


ALTER TABLE "public"."vrp_route" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vrp_route_step" (
    "id" bigint NOT NULL,
    "route_id" "uuid" NOT NULL,
    "step_index" integer NOT NULL,
    "type" "text" NOT NULL,
    "location" "extensions"."geometry"(Point,4326),
    "arrival" integer,
    "duration" integer,
    "setup" integer,
    "service" integer,
    "waiting_time" integer,
    "load" integer[],
    "solution_id" "uuid" NOT NULL,
    "package_id" "uuid"
);


ALTER TABLE "public"."vrp_route_step" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."vrp_route_step_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."vrp_route_step_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."vrp_route_step_id_seq" OWNED BY "public"."vrp_route_step"."id";



CREATE TABLE IF NOT EXISTS "public"."vrp_solution" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cost" integer,
    "routes_count" integer,
    "unassigned_count" integer,
    "delivery" integer[],
    "amount" integer[],
    "pickup" integer[],
    "setup" integer,
    "service" integer,
    "duration" integer,
    "waiting_time" integer,
    "priority" integer,
    "loading_time" integer,
    "solving_time" integer,
    "routing_time" integer,
    "optimization_id" "uuid" NOT NULL
);


ALTER TABLE "public"."vrp_solution" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vrp_unassigned_job" (
    "id" bigint NOT NULL,
    "solution_id" "uuid" NOT NULL,
    "job_id" integer,
    "location" "extensions"."geometry"(Point,4326),
    "type" "text"
);


ALTER TABLE "public"."vrp_unassigned_job" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."vrp_unassigned_job_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."vrp_unassigned_job_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."vrp_unassigned_job_id_seq" OWNED BY "public"."vrp_unassigned_job"."id";



CREATE TABLE IF NOT EXISTS "stripe"."issuing_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    "driver_id" "uuid" NOT NULL,
    "stripe_card_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "stripe"."issuing_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "stripe"."organisation_accounts" (
    "organisation_id" "uuid" NOT NULL,
    "stripe_account_id" "text",
    "onboarded_at" timestamp with time zone
);


ALTER TABLE "stripe"."organisation_accounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "stripe"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "package_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "stripe_checkout_session_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "organisation_id" "uuid" NOT NULL
);


ALTER TABLE "stripe"."payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "tzdata"."timezone" (
    "id" integer NOT NULL,
    "tzid" "text" NOT NULL,
    "geom" "extensions"."geometry"(MultiPolygon,4326) NOT NULL
);


ALTER TABLE "tzdata"."timezone" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "tzdata"."timezone_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "tzdata"."timezone_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "tzdata"."timezone_id_seq" OWNED BY "tzdata"."timezone"."id";



ALTER TABLE ONLY "public"."vrp_route_step" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."vrp_route_step_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."vrp_unassigned_job" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."vrp_unassigned_job_id_seq"'::"regclass");



ALTER TABLE ONLY "tzdata"."timezone" ALTER COLUMN "id" SET DEFAULT "nextval"('"tzdata"."timezone_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."app_permission"
    ADD CONSTRAINT "app_permission_permission_key" UNIQUE ("permission");



ALTER TABLE ONLY "public"."app_permission"
    ADD CONSTRAINT "app_permission_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_roles"
    ADD CONSTRAINT "app_roles_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."app_roles"
    ADD CONSTRAINT "app_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_current_location"
    ADD CONSTRAINT "driver_current_location_driver_id_key" UNIQUE ("driver_id");



ALTER TABLE ONLY "public"."driver_current_location"
    ADD CONSTRAINT "driver_current_location_pkey" PRIMARY KEY ("driver_id");



ALTER TABLE ONLY "public"."driver_location_history"
    ADD CONSTRAINT "driver_location_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."driver_vehicle_assignment"
    ADD CONSTRAINT "driver_vehicle_assignment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_id_key" UNIQUE ("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organisation_invitation_permissions"
    ADD CONSTRAINT "organisation_invitation_permissions_pkey" PRIMARY KEY ("invitation_id", "permission_id");



ALTER TABLE ONLY "public"."organisation_invitations"
    ADD CONSTRAINT "organisation_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organisations"
    ADD CONSTRAINT "organisations_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."organisations"
    ADD CONSTRAINT "organisations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organisations"
    ADD CONSTRAINT "organisations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."package_assignment"
    ADD CONSTRAINT "package_assignment_pkey" PRIMARY KEY ("package_id");



ALTER TABLE ONLY "public"."package_delivery_window"
    ADD CONSTRAINT "package_delivery_window_pkey" PRIMARY KEY ("package_id");



ALTER TABLE ONLY "public"."package_dimensions"
    ADD CONSTRAINT "package_dimensions_pkey" PRIMARY KEY ("package_id");



ALTER TABLE ONLY "public"."package_failure"
    ADD CONSTRAINT "package_failure_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."package_proof_of_delivery"
    ADD CONSTRAINT "package_proof_of_delivery_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."package_status"
    ADD CONSTRAINT "package_status_enums_key" UNIQUE ("enums");



ALTER TABLE ONLY "public"."package_status"
    ADD CONSTRAINT "package_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."package_status"
    ADD CONSTRAINT "package_status_status_key" UNIQUE ("status");



ALTER TABLE ONLY "public"."package_timeline"
    ADD CONSTRAINT "package_timeline_package_status_unique" UNIQUE ("package_id", "package_status");



ALTER TABLE ONLY "public"."package_timeline"
    ADD CONSTRAINT "package_timeline_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_tracking_number_key" UNIQUE ("tracking_number");



ALTER TABLE ONLY "public"."pod_type"
    ADD CONSTRAINT "pod_type_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."pod_type"
    ADD CONSTRAINT "pod_type_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permission"
    ADD CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id", "permission_id");



ALTER TABLE ONLY "public"."scheduler_runs"
    ADD CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scheduler_runs"
    ADD CONSTRAINT "scheduler_runs_warehouse_id_run_date_key" UNIQUE ("warehouse_id", "run_date");



ALTER TABLE ONLY "public"."service_areas"
    ADD CONSTRAINT "service_area_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."service_areas"
    ADD CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("organisation_id", "id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "unique_package_optimisation" UNIQUE ("id", "optimisation_id");



ALTER TABLE ONLY "public"."user_permission"
    ADD CONSTRAINT "user_permission_pkey" PRIMARY KEY ("organisation_id", "user_id", "permission_id");



ALTER TABLE ONLY "public"."vehicle_maintenance"
    ADD CONSTRAINT "vehicle_maintenance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vehicle_type"
    ADD CONSTRAINT "vehicle_type_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_vehicle_plate_key" UNIQUE ("vehicle_plate");



ALTER TABLE ONLY "public"."vrp_optimization"
    ADD CONSTRAINT "vrp_optimization_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vrp_route"
    ADD CONSTRAINT "vrp_route_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vrp_route_step"
    ADD CONSTRAINT "vrp_route_step_package_id_key" UNIQUE ("package_id");



ALTER TABLE ONLY "public"."vrp_route_step"
    ADD CONSTRAINT "vrp_route_step_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vrp_route_step"
    ADD CONSTRAINT "vrp_route_step_unique" UNIQUE ("route_id", "step_index");



ALTER TABLE ONLY "public"."vrp_solution"
    ADD CONSTRAINT "vrp_solution_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vrp_unassigned_job"
    ADD CONSTRAINT "vrp_unassigned_job_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."warehouse"
    ADD CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "stripe"."issuing_cards"
    ADD CONSTRAINT "issuing_cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "stripe"."issuing_cards"
    ADD CONSTRAINT "issuing_cards_stripe_card_id_key" UNIQUE ("stripe_card_id");



ALTER TABLE ONLY "stripe"."organisation_accounts"
    ADD CONSTRAINT "organisation_accounts_pkey" PRIMARY KEY ("organisation_id");



ALTER TABLE ONLY "stripe"."organisation_accounts"
    ADD CONSTRAINT "organisation_accounts_stripe_account_id_key" UNIQUE ("stripe_account_id");



ALTER TABLE ONLY "stripe"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "stripe"."payments"
    ADD CONSTRAINT "payments_stripe_checkout_session_id_key" UNIQUE ("stripe_checkout_session_id");



ALTER TABLE ONLY "tzdata"."timezone"
    ADD CONSTRAINT "timezone_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "tzdata"."timezone"
    ADD CONSTRAINT "timezone_tzid_unique" UNIQUE ("tzid");



CREATE UNIQUE INDEX "customer_org_phone_unique" ON "public"."customer" USING "btree" ("organisation_id", "lower"("customer_phone")) WHERE ("customer_phone" IS NOT NULL);



CREATE INDEX "customer_organisation_id_idx" ON "public"."customer" USING "btree" ("organisation_id");



CREATE INDEX "customer_stripe_customer_id_idx" ON "public"."customer" USING "btree" ("stripe_customer_id") WHERE ("stripe_customer_id" IS NOT NULL);



CREATE INDEX "driver_location_history_drv_idx" ON "public"."driver_location_history" USING "btree" ("driver_id", "created_at" DESC);



CREATE INDEX "drivers_id_idx" ON "public"."drivers" USING "btree" ("id" DESC);



CREATE INDEX "drivers_organisation_id_idx" ON "public"."drivers" USING "btree" ("organisation_id");



CREATE INDEX "dva_driver_id_idx" ON "public"."driver_vehicle_assignment" USING "btree" ("driver_id");



CREATE INDEX "dva_vehicle_id_idx" ON "public"."driver_vehicle_assignment" USING "btree" ("vehicle_id");



CREATE INDEX "idx_app_permission_permission" ON "public"."app_permission" USING "btree" ("permission");



CREATE INDEX "idx_customer_email_trgm" ON "public"."customer" USING "gin" ("customer_email" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_customer_name_trgm" ON "public"."customer" USING "gin" ("customer_name" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_customer_phone_trgm" ON "public"."customer" USING "gin" ("customer_phone" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_driver_location_history_driver_created" ON "public"."driver_location_history" USING "btree" ("driver_id", "created_at" DESC);



CREATE INDEX "idx_driver_vehicle_assignment_driver_id" ON "public"."driver_vehicle_assignment" USING "btree" ("driver_id");



CREATE INDEX "idx_driver_vehicle_assignment_vehicle_id" ON "public"."driver_vehicle_assignment" USING "btree" ("vehicle_id");



CREATE INDEX "idx_drivers_warehouse_id" ON "public"."drivers" USING "btree" ("warehouse_id");



CREATE INDEX "idx_package_assignment_driver_id" ON "public"."package_assignment" USING "btree" ("driver_id");



CREATE INDEX "idx_package_assignment_vehicle_id" ON "public"."package_assignment" USING "btree" ("vehicle_id");



CREATE INDEX "idx_package_failure_package_id" ON "public"."package_failure" USING "btree" ("package_id");



CREATE INDEX "idx_package_timeline_latest" ON "public"."package_timeline" USING "btree" ("package_id", "created_at" DESC);



CREATE INDEX "idx_package_timeline_package" ON "public"."package_timeline" USING "btree" ("package_id", "package_status");



CREATE INDEX "idx_packages_from_customer" ON "public"."packages" USING "btree" ("from_customer");



CREATE INDEX "idx_packages_to_customer" ON "public"."packages" USING "btree" ("to_customer");



CREATE INDEX "idx_pod_package" ON "public"."package_proof_of_delivery" USING "btree" ("package_id");



CREATE INDEX "idx_service_areas_geometry" ON "public"."service_areas" USING "gist" ("geometry");



CREATE UNIQUE INDEX "idx_unique_package_pod_type" ON "public"."package_proof_of_delivery" USING "btree" ("package_id", "pod_type_id");



CREATE INDEX "idx_vehicles_vehicle_type" ON "public"."vehicles" USING "btree" ("vehicle_type");



CREATE INDEX "idx_vehicles_warehouse_id" ON "public"."vehicles" USING "btree" ("warehouse_id");



CREATE INDEX "idx_vrp_route_solution_id" ON "public"."vrp_route" USING "btree" ("solution_id");



CREATE INDEX "idx_vrp_route_step_route_id" ON "public"."vrp_route_step" USING "btree" ("route_id");



CREATE INDEX "idx_warehouse_address_trgm" ON "public"."warehouse" USING "gin" ("warehouse_address" "extensions"."gin_trgm_ops");



CREATE INDEX "idx_warehouse_location" ON "public"."warehouse" USING "gist" ("warehouse_location");



CREATE INDEX "idx_warehouse_name_trgm" ON "public"."warehouse" USING "gin" ("warehouse_name" "extensions"."gin_trgm_ops");



CREATE INDEX "organisation_invitations_email_idx" ON "public"."organisation_invitations" USING "btree" ("email") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "organisation_invitations_unique_pending" ON "public"."organisation_invitations" USING "btree" ("organisation_id", "email") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "organisations_one_personal_per_user" ON "public"."organisations" USING "btree" ("created_by") WHERE ("org_type" = 'personal'::"text");



CREATE INDEX "package_assignment_driver_id_idx" ON "public"."package_assignment" USING "btree" ("driver_id");



CREATE INDEX "package_timeline_package_id_idx" ON "public"."package_timeline" USING "btree" ("package_id");



CREATE INDEX "package_timeline_pkg_created_idx" ON "public"."package_timeline" USING "btree" ("package_id", "created_at" DESC, "id" DESC);



CREATE INDEX "packages_created_at_idx" ON "public"."packages" USING "btree" ("created_at");



CREATE INDEX "packages_from_customer_idx" ON "public"."packages" USING "btree" ("from_customer");



CREATE INDEX "packages_optimisation_id_idx" ON "public"."packages" USING "btree" ("optimisation_id");



CREATE INDEX "packages_organisation_id_idx" ON "public"."packages" USING "btree" ("organisation_id");



CREATE INDEX "packages_to_customer_idx" ON "public"."packages" USING "btree" ("to_customer");



CREATE INDEX "packages_warehouse_id_idx" ON "public"."packages" USING "btree" ("warehouse_id");



CREATE INDEX "scheduler_runs_organisation_id_idx" ON "public"."scheduler_runs" USING "btree" ("organisation_id");



CREATE INDEX "service_areas_organisation_id_idx" ON "public"."service_areas" USING "btree" ("organisation_id");



CREATE INDEX "team_members_id_idx" ON "public"."team_members" USING "btree" ("id");



CREATE INDEX "team_members_user_idx" ON "public"."team_members" USING "btree" ("id");



CREATE INDEX "user_permission_org_user_idx" ON "public"."user_permission" USING "btree" ("organisation_id", "user_id");



CREATE INDEX "user_permission_permission_id_idx" ON "public"."user_permission" USING "btree" ("permission_id");



CREATE INDEX "user_permission_user_id_idx" ON "public"."user_permission" USING "btree" ("user_id");



CREATE INDEX "user_permission_user_org_idx" ON "public"."user_permission" USING "btree" ("user_id", "organisation_id");



CREATE INDEX "vehicle_maintenance_organisation_id_idx" ON "public"."vehicle_maintenance" USING "btree" ("organisation_id");



CREATE INDEX "vehicle_maintenance_user_id_idx" ON "public"."vehicle_maintenance" USING "btree" ("user_id");



CREATE INDEX "vehicle_maintenance_vehicle_id_idx" ON "public"."vehicle_maintenance" USING "btree" ("vehicle_id");



CREATE INDEX "vehicles_organisation_id_idx" ON "public"."vehicles" USING "btree" ("organisation_id");



CREATE INDEX "vrp_optimization_org_idx" ON "public"."vrp_optimization" USING "btree" ("organisation_id");



CREATE INDEX "vrp_route_solution_id_idx" ON "public"."vrp_route" USING "btree" ("solution_id");



CREATE INDEX "vrp_route_step_location_idx" ON "public"."vrp_route_step" USING "gist" ("location");



CREATE INDEX "vrp_route_step_package_id_idx" ON "public"."vrp_route_step" USING "btree" ("package_id");



CREATE INDEX "vrp_route_step_route_id_idx" ON "public"."vrp_route_step" USING "btree" ("route_id");



CREATE INDEX "vrp_route_step_solution_id_idx" ON "public"."vrp_route_step" USING "btree" ("solution_id");



CREATE INDEX "vrp_solution_optimization_idx" ON "public"."vrp_solution" USING "btree" ("optimization_id");



CREATE INDEX "vrp_unassigned_location_idx" ON "public"."vrp_unassigned_job" USING "gist" ("location");



CREATE INDEX "warehouse_organisation_id_idx" ON "public"."warehouse" USING "btree" ("organisation_id");



CREATE INDEX "issuing_cards_driver_id_idx" ON "stripe"."issuing_cards" USING "btree" ("driver_id");



CREATE INDEX "issuing_cards_organisation_id_idx" ON "stripe"."issuing_cards" USING "btree" ("organisation_id");



CREATE INDEX "organisation_accounts_stripe_account_id_idx" ON "stripe"."organisation_accounts" USING "btree" ("stripe_account_id");



CREATE INDEX "payments_organisation_id_idx" ON "stripe"."payments" USING "btree" ("organisation_id");



CREATE INDEX "timezone_geom_idx" ON "tzdata"."timezone" USING "gist" ("geom");



CREATE CONSTRAINT TRIGGER "driver_move_guard" AFTER UPDATE OF "warehouse_id" ON "public"."drivers" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (("old"."warehouse_id" IS DISTINCT FROM "new"."warehouse_id")) EXECUTE FUNCTION "public"."prevent_driver_move_if_assigned"();



CREATE CONSTRAINT TRIGGER "driver_vehicle_same_warehouse" AFTER INSERT OR UPDATE ON "public"."driver_vehicle_assignment" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "public"."enforce_same_warehouse"();



CREATE OR REPLACE TRIGGER "enforce_driver_vehicle_warehouse" BEFORE INSERT OR UPDATE ON "public"."package_assignment" FOR EACH ROW EXECUTE FUNCTION "public"."validate_driver_vehicle_warehouse"();



CREATE OR REPLACE TRIGGER "packages_set_tracking_number" BEFORE INSERT ON "public"."packages" FOR EACH ROW EXECUTE FUNCTION "public"."set_tracking_number"();



CREATE OR REPLACE TRIGGER "tr_check_vehicle_soft_deletion_rules" BEFORE UPDATE ON "public"."vehicles" FOR EACH ROW EXECUTE FUNCTION "public"."check_vehicle_soft_deletion_rules"();



CREATE OR REPLACE TRIGGER "tr_handle_vehicle_storage_cleanup_soft" AFTER UPDATE ON "public"."vehicles" FOR EACH ROW EXECUTE FUNCTION "public"."handle_vehicle_storage_cleanup_soft"();



CREATE OR REPLACE TRIGGER "trg_broadcast_driver_location" AFTER INSERT OR UPDATE OF "location" ON "public"."driver_current_location" FOR EACH ROW EXECUTE FUNCTION "public"."broadcast_driver_location_to_tracking"();



CREATE OR REPLACE TRIGGER "trg_driver_self_update_columns" BEFORE UPDATE ON "public"."drivers" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_driver_self_update_columns"();



CREATE OR REPLACE TRIGGER "trg_enforce_package_failed_status" BEFORE INSERT ON "public"."package_failure" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_package_failed_status"();



CREATE OR REPLACE TRIGGER "trg_handle_new_organisation" AFTER INSERT ON "public"."organisations" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_organisation"();



CREATE OR REPLACE TRIGGER "trg_log_driver_location_history" AFTER INSERT OR UPDATE ON "public"."driver_current_location" FOR EACH ROW EXECUTE FUNCTION "public"."log_driver_location_history"();



CREATE OR REPLACE TRIGGER "trg_prevent_manual_status_update" BEFORE UPDATE ON "public"."packages" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_manual_status_update"();



CREATE CONSTRAINT TRIGGER "vehicle_move_guard" AFTER UPDATE OF "warehouse_id" ON "public"."vehicles" DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (("old"."warehouse_id" IS DISTINCT FROM "new"."warehouse_id")) EXECUTE FUNCTION "public"."prevent_vehicle_move_if_assigned"();



ALTER TABLE ONLY "public"."customer"
    ADD CONSTRAINT "customer_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."driver_current_location"
    ADD CONSTRAINT "driver_current_location_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."driver_location_history"
    ADD CONSTRAINT "driver_location_history_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."driver_vehicle_assignment"
    ADD CONSTRAINT "driver_vehicle_assignment_driver_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id");



ALTER TABLE ONLY "public"."driver_vehicle_assignment"
    ADD CONSTRAINT "driver_vehicle_assignment_vehicle_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_license_type_fkey" FOREIGN KEY ("license_type") REFERENCES "public"."vehicle_type"("id");



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drivers"
    ADD CONSTRAINT "drivers_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organisation_invitation_permissions"
    ADD CONSTRAINT "organisation_invitation_permissions_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "public"."organisation_invitations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organisation_invitation_permissions"
    ADD CONSTRAINT "organisation_invitation_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."app_permission"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organisation_invitations"
    ADD CONSTRAINT "organisation_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."organisation_invitations"
    ADD CONSTRAINT "organisation_invitations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."organisation_invitations"
    ADD CONSTRAINT "organisation_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."app_roles"("id");



ALTER TABLE ONLY "public"."organisations"
    ADD CONSTRAINT "organisations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."package_assignment"
    ADD CONSTRAINT "package_assignment_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id");



ALTER TABLE ONLY "public"."package_assignment"
    ADD CONSTRAINT "package_assignment_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."package_assignment"
    ADD CONSTRAINT "package_assignment_vehicle_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id");



ALTER TABLE ONLY "public"."package_delivery_window"
    ADD CONSTRAINT "package_delivery_window_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."package_dimensions"
    ADD CONSTRAINT "package_dimensions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."package_failure"
    ADD CONSTRAINT "package_failure_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."package_proof_of_delivery"
    ADD CONSTRAINT "package_proof_of_delivery_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id");



ALTER TABLE ONLY "public"."package_proof_of_delivery"
    ADD CONSTRAINT "package_proof_of_delivery_pod_type_id_fkey" FOREIGN KEY ("pod_type_id") REFERENCES "public"."pod_type"("id");



ALTER TABLE ONLY "public"."package_timeline"
    ADD CONSTRAINT "package_timeline_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."package_timeline"
    ADD CONSTRAINT "package_timeline_package_status_fkey" FOREIGN KEY ("package_status") REFERENCES "public"."package_status"("id");



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_from_customer_fkey" FOREIGN KEY ("from_customer") REFERENCES "public"."customer"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_optimisation_id_fkey" FOREIGN KEY ("optimisation_id") REFERENCES "public"."vrp_optimization"("id") ON UPDATE CASCADE;



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_to_customer_fkey" FOREIGN KEY ("to_customer") REFERENCES "public"."customer"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."packages"
    ADD CONSTRAINT "packages_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permission"
    ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."app_permission"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_permission"
    ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."app_roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scheduler_runs"
    ADD CONSTRAINT "scheduler_runs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scheduler_runs"
    ADD CONSTRAINT "scheduler_runs_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_areas"
    ADD CONSTRAINT "service_areas_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."app_roles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_permission"
    ADD CONSTRAINT "user_permission_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_permission"
    ADD CONSTRAINT "user_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "public"."app_permission"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_permission"
    ADD CONSTRAINT "user_permission_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vehicle_maintenance"
    ADD CONSTRAINT "vehicle_maintenance_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vehicle_maintenance"
    ADD CONSTRAINT "vehicle_maintenance_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vehicle_maintenance"
    ADD CONSTRAINT "vehicle_maintenance_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_vehicle_type_fkey" FOREIGN KEY ("vehicle_type") REFERENCES "public"."vehicle_type"("id");



ALTER TABLE ONLY "public"."vehicles"
    ADD CONSTRAINT "vehicles_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vrp_optimization"
    ADD CONSTRAINT "vrp_optimization_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vrp_route"
    ADD CONSTRAINT "vrp_route_solution_id_fkey" FOREIGN KEY ("solution_id") REFERENCES "public"."vrp_solution"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vrp_route_step"
    ADD CONSTRAINT "vrp_route_step_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."package_assignment"("package_id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vrp_route_step"
    ADD CONSTRAINT "vrp_route_step_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."vrp_route"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vrp_route_step"
    ADD CONSTRAINT "vrp_route_step_solution_id_fkey" FOREIGN KEY ("solution_id") REFERENCES "public"."vrp_solution"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vrp_solution"
    ADD CONSTRAINT "vrp_solution_optimization_id_fkey" FOREIGN KEY ("optimization_id") REFERENCES "public"."vrp_optimization"("id") ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vrp_unassigned_job"
    ADD CONSTRAINT "vrp_unassigned_job_solution_id_fkey" FOREIGN KEY ("solution_id") REFERENCES "public"."vrp_solution"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."warehouse"
    ADD CONSTRAINT "warehouse_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "stripe"."issuing_cards"
    ADD CONSTRAINT "issuing_cards_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "stripe"."organisation_accounts"
    ADD CONSTRAINT "organisation_accounts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "stripe"."payments"
    ADD CONSTRAINT "payments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "stripe"."payments"
    ADD CONSTRAINT "payments_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE SET NULL;



CREATE POLICY "app permission read" ON "public"."app_permission" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "app roles read" ON "public"."app_roles" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."app_permission" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customer" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer delete org" ON "public"."customer" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'customers.delete'::"text"));



CREATE POLICY "customer insert org" ON "public"."customer" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'customers.add'::"text"));



CREATE POLICY "customer insert personal owner" ON "public"."customer" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "customer select org or active assigned driver" ON "public"."customer" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'customers.view'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."packages" "p"
     JOIN "public"."package_assignment" "pa" ON (("pa"."package_id" = "p"."id")))
  WHERE ((("p"."from_customer" = "customer"."id") OR ("p"."to_customer" = "customer"."id")) AND ("pa"."driver_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("public"."package_latest_status"("p"."id") IS DISTINCT FROM 'DELIVERED'::"text"))))));



CREATE POLICY "customer select personal owner" ON "public"."customer" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "customer update org" ON "public"."customer" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'customers.update'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'customers.update'::"text"));



CREATE POLICY "customer update personal owner" ON "public"."customer" FOR UPDATE TO "authenticated" USING ("public"."is_personal_org_owner"("organisation_id")) WITH CHECK ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "delivery window delete org" ON "public"."package_delivery_window" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.delete'::"text"));



CREATE POLICY "delivery window insert org" ON "public"."package_delivery_window" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.add'::"text") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text")));



CREATE POLICY "delivery window insert personal owner" ON "public"."package_delivery_window" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_personal_org_owner"("public"."package_org"("package_id")));



CREATE POLICY "delivery window select org or assigned driver" ON "public"."package_delivery_window" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.view'::"text") OR "public"."is_assigned_driver"("package_id")));



CREATE POLICY "delivery window select personal owner" ON "public"."package_delivery_window" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("public"."package_org"("package_id")));



CREATE POLICY "delivery window update org" ON "public"."package_delivery_window" FOR UPDATE TO "authenticated" USING (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text"))) WITH CHECK (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text")));



CREATE POLICY "delivery window update personal owner" ON "public"."package_delivery_window" FOR UPDATE TO "authenticated" USING ("public"."is_personal_org_owner"("public"."package_org"("package_id"))) WITH CHECK ("public"."is_personal_org_owner"("public"."package_org"("package_id")));



CREATE POLICY "driver location history insert self" ON "public"."driver_location_history" FOR INSERT TO "authenticated" WITH CHECK (("driver_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "driver location history select self or org" ON "public"."driver_location_history" FOR SELECT TO "authenticated" USING ((("driver_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_permission_for_driver"("driver_id", 'locations.view'::"text")));



CREATE POLICY "driver location insert self" ON "public"."driver_current_location" FOR INSERT TO "authenticated" WITH CHECK (("driver_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "driver location select self or org" ON "public"."driver_current_location" FOR SELECT TO "authenticated" USING ((("driver_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_permission_for_driver"("driver_id", 'locations.view'::"text")));



CREATE POLICY "driver location update self" ON "public"."driver_current_location" FOR UPDATE TO "authenticated" USING (("driver_id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("driver_id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."driver_current_location" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_location_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."driver_vehicle_assignment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drivers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drivers delete org" ON "public"."drivers" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'drivers.delete'::"text"));



CREATE POLICY "drivers insert org" ON "public"."drivers" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'drivers.add'::"text"));



CREATE POLICY "drivers select self or org viewers" ON "public"."drivers" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("organisation_id", 'drivers.view'::"text")));



CREATE POLICY "drivers update self or org editors" ON "public"."drivers" FOR UPDATE TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("organisation_id", 'drivers.update'::"text"))) WITH CHECK ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("organisation_id", 'drivers.update'::"text")));



CREATE POLICY "dva delete org" ON "public"."driver_vehicle_assignment" FOR DELETE TO "authenticated" USING ("public"."has_permission_for_driver"("driver_id", 'drivers.update'::"text"));



CREATE POLICY "dva insert org same org pair" ON "public"."driver_vehicle_assignment" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_permission_for_driver"("driver_id", 'drivers.update'::"text") AND "public"."driver_vehicle_same_org"("driver_id", "vehicle_id")));



CREATE POLICY "dva select own or org viewers" ON "public"."driver_vehicle_assignment" FOR SELECT TO "authenticated" USING ((("driver_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_permission_for_driver"("driver_id", 'drivers.view'::"text")));



CREATE POLICY "dva update org same org pair" ON "public"."driver_vehicle_assignment" FOR UPDATE TO "authenticated" USING ("public"."has_permission_for_driver"("driver_id", 'drivers.update'::"text")) WITH CHECK (("public"."has_permission_for_driver"("driver_id", 'drivers.update'::"text") AND "public"."driver_vehicle_same_org"("driver_id", "vehicle_id")));



CREATE POLICY "invitation permissions delete managers" ON "public"."organisation_invitation_permissions" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."organisation_invitations" "i"
  WHERE (("i"."id" = "organisation_invitation_permissions"."invitation_id") AND "public"."has_org_permission"("i"."organisation_id", 'team_members.edit'::"text")))));



CREATE POLICY "invitation permissions insert via parent" ON "public"."organisation_invitation_permissions" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."organisation_invitations" "i"
  WHERE (("i"."id" = "organisation_invitation_permissions"."invitation_id") AND ("public"."has_org_permission"("i"."organisation_id", 'team_members.add'::"text") OR ("public"."has_org_permission"("i"."organisation_id", 'drivers.add'::"text") AND ("i"."role_id" = ( SELECT "r"."id"
           FROM "public"."app_roles" "r"
          WHERE ("r"."name" = 'Driver'::"text")))))))));



CREATE POLICY "invitation permissions select via parent" ON "public"."organisation_invitation_permissions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."organisation_invitations" "i"
  WHERE ("i"."id" = "organisation_invitation_permissions"."invitation_id"))));



CREATE POLICY "invitations delete managers" ON "public"."organisation_invitations" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'team_members.delete'::"text"));



CREATE POLICY "invitations insert managers any dispatchers drivers only" ON "public"."organisation_invitations" FOR INSERT TO "authenticated" WITH CHECK ((("invited_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("public"."has_org_permission"("organisation_id", 'team_members.add'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.add'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text")))))));



CREATE POLICY "invitations select inviter managers dispatchers" ON "public"."organisation_invitations" FOR SELECT TO "authenticated" USING ((("invited_by_user_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("organisation_id", 'team_members.view'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.view'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text"))))));



CREATE POLICY "invitations update managers any dispatchers drivers only" ON "public"."organisation_invitations" FOR UPDATE TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text")))))) WITH CHECK (("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text"))))));



ALTER TABLE "public"."organisation_invitation_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organisation_invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organisations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organisations insert as creator" ON "public"."organisations" FOR INSERT TO "authenticated" WITH CHECK (("created_by" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "organisations select member or creator" ON "public"."organisations" FOR SELECT TO "authenticated" USING ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."is_org_member"("id")));



CREATE POLICY "organisations update by org admin" ON "public"."organisations" FOR UPDATE TO "authenticated" USING ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("id", 'organisation.edit'::"text"))) WITH CHECK ((("created_by" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("id", 'organisation.edit'::"text")));



CREATE POLICY "package assignment delete org" ON "public"."package_assignment" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text"));



CREATE POLICY "package assignment insert org" ON "public"."package_assignment" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text"));



CREATE POLICY "package assignment select own or org" ON "public"."package_assignment" FOR SELECT TO "authenticated" USING ((("driver_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("public"."package_org"("package_id"), 'packages.view'::"text")));



CREATE POLICY "package assignment update org" ON "public"."package_assignment" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text")) WITH CHECK ("public"."has_org_permission"("public"."package_org"("package_id"), 'shifts.assign'::"text"));



CREATE POLICY "package dimensions delete org" ON "public"."package_dimensions" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.delete'::"text"));



CREATE POLICY "package dimensions insert org" ON "public"."package_dimensions" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.add'::"text"));



CREATE POLICY "package dimensions select org or assigned driver" ON "public"."package_dimensions" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.view'::"text") OR "public"."is_assigned_driver"("package_id")));



CREATE POLICY "package dimensions update org" ON "public"."package_dimensions" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text")) WITH CHECK ("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text"));



CREATE POLICY "package failure insert driver or org" ON "public"."package_failure" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_assigned_driver"("package_id") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text")));



CREATE POLICY "package failure select org or assigned driver" ON "public"."package_failure" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.view'::"text") OR "public"."is_assigned_driver"("package_id")));



CREATE POLICY "package pod insert driver or org" ON "public"."package_proof_of_delivery" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_assigned_driver"("package_id") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text")));



CREATE POLICY "package pod select org or assigned driver" ON "public"."package_proof_of_delivery" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."package_org"("package_id"), 'packages.view'::"text") OR "public"."is_assigned_driver"("package_id")));



CREATE POLICY "package status read" ON "public"."package_status" FOR SELECT TO "anon", "authenticated" USING (true);



CREATE POLICY "package timeline insert driver or org" ON "public"."package_timeline" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_assigned_driver"("package_id") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'packages.update'::"text")));



CREATE POLICY "package timeline select org or assigned driver" ON "public"."package_timeline" FOR SELECT TO "authenticated" USING (("public"."is_assigned_driver"("package_id") OR "public"."has_org_permission"("public"."package_org"("package_id"), 'packages.view'::"text")));



ALTER TABLE "public"."package_assignment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."package_delivery_window" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."package_dimensions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."package_failure" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."package_proof_of_delivery" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."package_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."package_timeline" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "packages delete org" ON "public"."packages" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'packages.delete'::"text"));



CREATE POLICY "packages insert org" ON "public"."packages" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'packages.add'::"text"));



CREATE POLICY "packages insert personal owner" ON "public"."packages" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "packages select org or assigned driver" ON "public"."packages" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'packages.view'::"text") OR "public"."is_assigned_driver"("id")));



CREATE POLICY "packages select personal owner" ON "public"."packages" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "packages update org" ON "public"."packages" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'packages.update'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'packages.update'::"text"));



CREATE POLICY "packages update personal owner" ON "public"."packages" FOR UPDATE TO "authenticated" USING ("public"."is_personal_org_owner"("organisation_id")) WITH CHECK ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "pod type read" ON "public"."pod_type" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."pod_type" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role permission read" ON "public"."role_permission" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."role_permission" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scheduler runs select org" ON "public"."scheduler_runs" FOR SELECT TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'shifts.view'::"text"));



ALTER TABLE "public"."scheduler_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service areas delete org" ON "public"."service_areas" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"));



CREATE POLICY "service areas insert org" ON "public"."service_areas" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"));



CREATE POLICY "service areas select org members" ON "public"."service_areas" FOR SELECT TO "authenticated" USING ("public"."is_org_member"("organisation_id"));



CREATE POLICY "service areas update org" ON "public"."service_areas" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'service_areas.edit'::"text"));



ALTER TABLE "public"."service_areas" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "team members delete managers any dispatchers drivers only" ON "public"."team_members" FOR DELETE TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'team_members.delete'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.delete'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text"))))));



CREATE POLICY "team members insert managers any dispatchers drivers only" ON "public"."team_members" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_org_permission"("organisation_id", 'team_members.add'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.add'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text"))))));



CREATE POLICY "team members select self managers all dispatchers drivers" ON "public"."team_members" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("organisation_id", 'team_members.view'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.view'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text"))))));



CREATE POLICY "team members update managers any dispatchers drivers only" ON "public"."team_members" FOR UPDATE TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text")))))) WITH CHECK (("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text") OR ("public"."has_org_permission"("organisation_id", 'drivers.update'::"text") AND ("role_id" = ( SELECT "r"."id"
   FROM "public"."app_roles" "r"
  WHERE ("r"."name" = 'Driver'::"text"))))));



ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user permission delete managers" ON "public"."user_permission" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text"));



CREATE POLICY "user permission insert managers" ON "public"."user_permission" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text"));



CREATE POLICY "user permission select own or managers" ON "public"."user_permission" FOR SELECT TO "authenticated" USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR "public"."has_org_permission"("organisation_id", 'team_members.view'::"text")));



CREATE POLICY "user permission update managers" ON "public"."user_permission" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'team_members.edit'::"text"));



ALTER TABLE "public"."user_permission" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vehicle maintenance delete org" ON "public"."vehicle_maintenance" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));



CREATE POLICY "vehicle maintenance insert org" ON "public"."vehicle_maintenance" FOR INSERT TO "authenticated" WITH CHECK (("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text") AND (("user_id" IS NULL) OR ("user_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "vehicle maintenance select org" ON "public"."vehicle_maintenance" FOR SELECT TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'vehicles.view'::"text"));



CREATE POLICY "vehicle maintenance update org" ON "public"."vehicle_maintenance" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));



CREATE POLICY "vehicle type read" ON "public"."vehicle_type" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."vehicle_maintenance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vehicle_type" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vehicles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vehicles delete org" ON "public"."vehicles" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'vehicles.delete'::"text"));



CREATE POLICY "vehicles insert org" ON "public"."vehicles" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.add'::"text"));



CREATE POLICY "vehicles select org or assigned driver" ON "public"."vehicles" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'vehicles.view'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."driver_vehicle_assignment" "a"
  WHERE (("a"."vehicle_id" = "vehicles"."id") AND ("a"."driver_id" = ( SELECT "auth"."uid"() AS "uid"))))) OR (EXISTS ( SELECT 1
   FROM "public"."package_assignment" "pa"
  WHERE (("pa"."vehicle_id" = "vehicles"."id") AND ("pa"."driver_id" = ( SELECT "auth"."uid"() AS "uid")))))));



CREATE POLICY "vehicles update org" ON "public"."vehicles" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'vehicles.update'::"text"));



CREATE POLICY "vrp optimization insert org" ON "public"."vrp_optimization" FOR INSERT TO "authenticated" WITH CHECK ((("organisation_id" IS NOT NULL) AND "public"."has_org_permission"("organisation_id", 'shifts.assign'::"text")));



CREATE POLICY "vrp optimization select org or driver" ON "public"."vrp_optimization" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."vrp_optimization_org"("id"), 'shifts.view'::"text") OR "public"."is_optimization_driver"("id")));



CREATE POLICY "vrp optimization select personal owner" ON "public"."vrp_optimization" FOR SELECT TO "authenticated" USING ((("organisation_id" IS NOT NULL) AND "public"."is_personal_org_owner"("organisation_id")));



CREATE POLICY "vrp route delete org" ON "public"."vrp_route" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp route insert org" ON "public"."vrp_route" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp route select org or driver" ON "public"."vrp_route" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.view'::"text") OR "public"."is_route_driver"("id")));



CREATE POLICY "vrp route select personal owner" ON "public"."vrp_route" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("public"."vrp_solution_org"("solution_id")));



CREATE POLICY "vrp route step delete org" ON "public"."vrp_route_step" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp route step insert org" ON "public"."vrp_route_step" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp route step select org or driver" ON "public"."vrp_route_step" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.view'::"text") OR "public"."is_route_driver"("route_id") OR (("package_id" IS NOT NULL) AND "public"."is_assigned_driver"("package_id"))));



CREATE POLICY "vrp route step select personal owner" ON "public"."vrp_route_step" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("public"."vrp_solution_org"("solution_id")));



CREATE POLICY "vrp route step update org" ON "public"."vrp_route_step" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text")) WITH CHECK ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp route update org" ON "public"."vrp_route" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text")) WITH CHECK ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp solution insert org" ON "public"."vrp_solution" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("public"."vrp_optimization_org"("optimization_id"), 'shifts.assign'::"text"));



CREATE POLICY "vrp solution select org or driver" ON "public"."vrp_solution" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("public"."vrp_optimization_org"("optimization_id"), 'shifts.view'::"text") OR "public"."is_solution_driver"("id")));



CREATE POLICY "vrp solution select personal owner" ON "public"."vrp_solution" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("public"."vrp_optimization_org"("optimization_id")));



CREATE POLICY "vrp unassigned job select org" ON "public"."vrp_unassigned_job" FOR SELECT TO "authenticated" USING ("public"."has_org_permission"("public"."vrp_solution_org"("solution_id"), 'shifts.view'::"text"));



ALTER TABLE "public"."vrp_optimization" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vrp_route" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vrp_route_step" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vrp_solution" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vrp_unassigned_job" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."warehouse" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "warehouse delete org" ON "public"."warehouse" FOR DELETE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'warehouse.delete'::"text"));



CREATE POLICY "warehouse insert org" ON "public"."warehouse" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_org_permission"("organisation_id", 'warehouse.add'::"text"));



CREATE POLICY "warehouse insert personal owner" ON "public"."warehouse" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "warehouse select org or own" ON "public"."warehouse" FOR SELECT TO "authenticated" USING (("public"."has_org_permission"("organisation_id", 'warehouse.view'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."drivers" "d"
  WHERE (("d"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("d"."warehouse_id" = "warehouse"."id"))))));



CREATE POLICY "warehouse select personal owner" ON "public"."warehouse" FOR SELECT TO "authenticated" USING ("public"."is_personal_org_owner"("organisation_id"));



CREATE POLICY "warehouse update org" ON "public"."warehouse" FOR UPDATE TO "authenticated" USING ("public"."has_org_permission"("organisation_id", 'warehouse.update'::"text")) WITH CHECK ("public"."has_org_permission"("organisation_id", 'warehouse.update'::"text"));



CREATE POLICY "warehouse update personal owner" ON "public"."warehouse" FOR UPDATE TO "authenticated" USING ("public"."is_personal_org_owner"("organisation_id")) WITH CHECK ("public"."is_personal_org_owner"("organisation_id"));



ALTER TABLE "stripe"."issuing_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "stripe"."organisation_accounts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "stripe"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "tzdata"."timezone" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."driver_current_location";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";





























































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































































REVOKE ALL ON FUNCTION "public"."broadcast_driver_location_to_tracking"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."broadcast_driver_location_to_tracking"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_vehicle_soft_deletion_rules"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_vehicle_soft_deletion_rules"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."driver_vehicle_same_org"("p_driver" "uuid", "p_vehicle" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."driver_vehicle_same_org"("p_driver" "uuid", "p_vehicle" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."driver_vehicle_same_org"("p_driver" "uuid", "p_vehicle" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_driver_self_update_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_driver_self_update_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_package_failed_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_package_failed_status"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_same_warehouse"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_same_warehouse"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."folder_package_id"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."folder_package_id"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."folder_package_id"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_tracking_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_tracking_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_booking_organisation"("p_slug" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_booking_organisation"("p_slug" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_booking_organisation"("p_slug" "text") TO "anon";



GRANT ALL ON FUNCTION "public"."get_driver_location_history"("p_driver_id" "uuid", "from_ts" timestamp with time zone, "to_ts" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_driver_location_history"("p_driver_id" "uuid", "from_ts" timestamp with time zone, "to_ts" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_drivers_by_ids"("p_driver_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_drivers_by_ids"("p_driver_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_drivers_paginated"("p_page" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_drivers_paginated"("p_page" integer, "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_optimisation_list"("p_limit" integer, "p_page" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_optimisation_list"("p_limit" integer, "p_page" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_service_area_extent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_service_area_extent"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_team_members_paginated"("p_page" integer, "p_limit" integer, "p_search" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_tracking_details"("p_tracking_number" "text", "p_slug" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_tracking_details"("p_tracking_number" "text", "p_slug" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_tracking_details"("p_tracking_number" "text", "p_slug" "text") TO "anon";



REVOKE ALL ON FUNCTION "public"."handle_new_organisation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_organisation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_vehicle_storage_cleanup_soft"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_vehicle_storage_cleanup_soft"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_org_permission"("p_org" "uuid", "p_permission" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_org_permission"("p_org" "uuid", "p_permission" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_org_permission"("p_org" "uuid", "p_permission" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_permission"("p_permission" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_permission"("p_permission" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_permission_for_driver"("p_driver" "uuid", "p_permission" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_permission_for_driver"("p_driver" "uuid", "p_permission" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_permission_for_driver"("p_driver" "uuid", "p_permission" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."insert_package_timeline"("p_package_id" "uuid", "p_status_enum" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."insert_package_timeline"("p_package_id" "uuid", "p_status_enum" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_assigned_driver"("p_package_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_assigned_driver"("p_package_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_assigned_driver"("p_package_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_optimization_driver"("p_opt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_optimization_driver"("p_opt_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_optimization_driver"("p_opt_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_org_member"("p_org" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_org_member"("p_org" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_org_member"("p_org" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_personal_org_owner"("p_org" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_personal_org_owner"("p_org" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_route_driver"("p_route_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_route_driver"("p_route_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_route_driver"("p_route_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_solution_driver"("p_solution_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_solution_driver"("p_solution_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_solution_driver"("p_solution_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_tracking_topic_in_transit"("p_topic" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_tracking_topic_in_transit"("p_topic" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."is_tracking_topic_in_transit"("p_topic" "text") TO "anon";



GRANT ALL ON FUNCTION "public"."list_drivers_by_warehouse"("p_warehouse_id" "uuid", "p_page" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_drivers_by_warehouse"("p_warehouse_id" "uuid", "p_page" integer, "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."list_unassigned_drivers"("p_page" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_unassigned_drivers"("p_page" integer, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."log_driver_location_history"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_driver_location_history"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."maintenance_folder_org"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."maintenance_folder_org"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."maintenance_folder_org"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."member_role_name"("p_org" "uuid", "p_user" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."member_role_name"("p_org" "uuid", "p_user" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."member_role_name"("p_org" "uuid", "p_user" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."package_folder_is_delivered"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."package_folder_is_delivered"("p_name" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."package_folder_is_delivered"("p_name" "text") TO "anon";



REVOKE ALL ON FUNCTION "public"."package_latest_status"("p_package_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."package_latest_status"("p_package_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."package_latest_status"("p_package_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."package_org"("p_package_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."package_org"("p_package_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."package_org"("p_package_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."prevent_driver_move_if_assigned"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_driver_move_if_assigned"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prevent_manual_status_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_manual_status_update"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prevent_vehicle_move_if_assigned"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_vehicle_move_if_assigned"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_tracking_number"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_tracking_number"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_driver_profile"("p_driver_id" "uuid", "p_driver_license" "text", "p_license_expiry" timestamp with time zone, "p_vehicle_type" "uuid", "p_email" "text", "p_phone" "text", "p_display_name" "text", "p_avatar_url" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_driver_profile"("p_driver_id" "uuid", "p_driver_license" "text", "p_license_expiry" timestamp with time zone, "p_vehicle_type" "uuid", "p_email" "text", "p_phone" "text", "p_display_name" "text", "p_avatar_url" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_driver_profile"("p_driver_id" "uuid", "p_driver_license" "text", "p_license_expiry" timestamp with time zone, "p_vehicle_type" "uuid", "p_email" "text", "p_phone" "text", "p_display_name" "text", "p_avatar_url" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_driver_vehicle_warehouse"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_driver_vehicle_warehouse"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."vehicle_folder_org"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vehicle_folder_org"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vehicle_folder_org"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."vrp_optimization_org"("p_opt_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vrp_optimization_org"("p_opt_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vrp_optimization_org"("p_opt_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."vrp_solution_org"("p_solution_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vrp_solution_org"("p_solution_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vrp_solution_org"("p_solution_id" "uuid") TO "service_role";
































































































GRANT ALL ON TABLE "public"."app_permission" TO "anon";
GRANT ALL ON TABLE "public"."app_permission" TO "authenticated";
GRANT ALL ON TABLE "public"."app_permission" TO "service_role";



GRANT ALL ON SEQUENCE "public"."app_permission_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."app_permission_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."app_permission_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."app_roles" TO "anon";
GRANT ALL ON TABLE "public"."app_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."app_roles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."app_roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."app_roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."app_roles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."customer" TO "anon";
GRANT ALL ON TABLE "public"."customer" TO "authenticated";
GRANT ALL ON TABLE "public"."customer" TO "service_role";



GRANT ALL ON TABLE "public"."driver_current_location" TO "anon";
GRANT ALL ON TABLE "public"."driver_current_location" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_current_location" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."driver_location_history" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."driver_location_history" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_location_history" TO "service_role";



GRANT ALL ON TABLE "public"."driver_vehicle_assignment" TO "anon";
GRANT ALL ON TABLE "public"."driver_vehicle_assignment" TO "authenticated";
GRANT ALL ON TABLE "public"."driver_vehicle_assignment" TO "service_role";



GRANT ALL ON TABLE "public"."drivers" TO "anon";
GRANT ALL ON TABLE "public"."drivers" TO "authenticated";
GRANT ALL ON TABLE "public"."drivers" TO "service_role";



GRANT ALL ON TABLE "public"."organisation_invitation_permissions" TO "anon";
GRANT ALL ON TABLE "public"."organisation_invitation_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."organisation_invitation_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."organisation_invitations" TO "anon";
GRANT ALL ON TABLE "public"."organisation_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."organisation_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."organisations" TO "anon";
GRANT ALL ON TABLE "public"."organisations" TO "authenticated";
GRANT ALL ON TABLE "public"."organisations" TO "service_role";



GRANT ALL ON TABLE "public"."package_assignment" TO "anon";
GRANT ALL ON TABLE "public"."package_assignment" TO "authenticated";
GRANT ALL ON TABLE "public"."package_assignment" TO "service_role";



GRANT ALL ON TABLE "public"."package_delivery_window" TO "anon";
GRANT ALL ON TABLE "public"."package_delivery_window" TO "authenticated";
GRANT ALL ON TABLE "public"."package_delivery_window" TO "service_role";



GRANT ALL ON TABLE "public"."package_dimensions" TO "anon";
GRANT ALL ON TABLE "public"."package_dimensions" TO "authenticated";
GRANT ALL ON TABLE "public"."package_dimensions" TO "service_role";



GRANT ALL ON TABLE "public"."package_failure" TO "anon";
GRANT ALL ON TABLE "public"."package_failure" TO "authenticated";
GRANT ALL ON TABLE "public"."package_failure" TO "service_role";



GRANT ALL ON TABLE "public"."package_proof_of_delivery" TO "anon";
GRANT ALL ON TABLE "public"."package_proof_of_delivery" TO "authenticated";
GRANT ALL ON TABLE "public"."package_proof_of_delivery" TO "service_role";



GRANT ALL ON SEQUENCE "public"."package_proof_of_delivery_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."package_proof_of_delivery_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."package_proof_of_delivery_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."package_status" TO "anon";
GRANT ALL ON TABLE "public"."package_status" TO "authenticated";
GRANT ALL ON TABLE "public"."package_status" TO "service_role";



GRANT ALL ON SEQUENCE "public"."package_status_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."package_status_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."package_status_id_seq" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."package_timeline" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."package_timeline" TO "authenticated";
GRANT ALL ON TABLE "public"."package_timeline" TO "service_role";



GRANT ALL ON SEQUENCE "public"."package_timeline_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."package_timeline_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."package_timeline_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."packages" TO "anon";
GRANT ALL ON TABLE "public"."packages" TO "authenticated";
GRANT ALL ON TABLE "public"."packages" TO "service_role";



GRANT ALL ON TABLE "public"."warehouse" TO "anon";
GRANT ALL ON TABLE "public"."warehouse" TO "authenticated";
GRANT ALL ON TABLE "public"."warehouse" TO "service_role";



GRANT ALL ON TABLE "public"."packages_with_latest_status" TO "anon";
GRANT ALL ON TABLE "public"."packages_with_latest_status" TO "authenticated";
GRANT ALL ON TABLE "public"."packages_with_latest_status" TO "service_role";



GRANT ALL ON TABLE "public"."pod_type" TO "anon";
GRANT ALL ON TABLE "public"."pod_type" TO "authenticated";
GRANT ALL ON TABLE "public"."pod_type" TO "service_role";



GRANT ALL ON SEQUENCE "public"."pod_type_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."pod_type_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."pod_type_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."role_permission" TO "anon";
GRANT ALL ON TABLE "public"."role_permission" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permission" TO "service_role";



GRANT ALL ON TABLE "public"."scheduler_runs" TO "anon";
GRANT ALL ON TABLE "public"."scheduler_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."scheduler_runs" TO "service_role";



GRANT ALL ON TABLE "public"."service_areas" TO "anon";
GRANT ALL ON TABLE "public"."service_areas" TO "authenticated";
GRANT ALL ON TABLE "public"."service_areas" TO "service_role";



GRANT ALL ON TABLE "public"."team_members" TO "anon";
GRANT ALL ON TABLE "public"."team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."team_members" TO "service_role";



GRANT ALL ON TABLE "public"."user_permission" TO "anon";
GRANT ALL ON TABLE "public"."user_permission" TO "authenticated";
GRANT ALL ON TABLE "public"."user_permission" TO "service_role";



GRANT ALL ON TABLE "public"."vehicle_maintenance" TO "anon";
GRANT ALL ON TABLE "public"."vehicle_maintenance" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicle_maintenance" TO "service_role";



GRANT ALL ON TABLE "public"."vehicle_type" TO "anon";
GRANT ALL ON TABLE "public"."vehicle_type" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicle_type" TO "service_role";



GRANT ALL ON TABLE "public"."vehicles" TO "anon";
GRANT ALL ON TABLE "public"."vehicles" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicles" TO "service_role";



GRANT ALL ON TABLE "public"."vrp_optimization" TO "anon";
GRANT ALL ON TABLE "public"."vrp_optimization" TO "authenticated";
GRANT ALL ON TABLE "public"."vrp_optimization" TO "service_role";



GRANT ALL ON TABLE "public"."vrp_route" TO "anon";
GRANT ALL ON TABLE "public"."vrp_route" TO "authenticated";
GRANT ALL ON TABLE "public"."vrp_route" TO "service_role";



GRANT ALL ON TABLE "public"."vrp_route_step" TO "anon";
GRANT ALL ON TABLE "public"."vrp_route_step" TO "authenticated";
GRANT ALL ON TABLE "public"."vrp_route_step" TO "service_role";



GRANT ALL ON SEQUENCE "public"."vrp_route_step_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."vrp_route_step_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."vrp_route_step_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."vrp_solution" TO "anon";
GRANT ALL ON TABLE "public"."vrp_solution" TO "authenticated";
GRANT ALL ON TABLE "public"."vrp_solution" TO "service_role";



GRANT ALL ON TABLE "public"."vrp_unassigned_job" TO "anon";
GRANT ALL ON TABLE "public"."vrp_unassigned_job" TO "authenticated";
GRANT ALL ON TABLE "public"."vrp_unassigned_job" TO "service_role";



GRANT ALL ON SEQUENCE "public"."vrp_unassigned_job_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."vrp_unassigned_job_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."vrp_unassigned_job_id_seq" TO "service_role";



GRANT ALL ON TABLE "stripe"."issuing_cards" TO "service_role";



GRANT ALL ON TABLE "stripe"."payments" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































