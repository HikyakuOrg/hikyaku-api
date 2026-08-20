-- Teaches the two SECURITY DEFINER functions that resolve an organisation
-- from a hostname-derived slug (get_booking_organisation, used by the public
-- booking page, and get_tracking_details, used by the public tracking page)
-- to also match on vanity_slug (AddOrganisationVanitySlug) -- but only while
-- the org is currently entitled to it. "Entitled" mirrors the meaning
-- trial.ts already gives subscription_status = 'grandfathered' ("unrestricted,
-- permanently"): a grandfathered company org never gets a Stripe customer, so
-- it is entitled unconditionally; every other company org is entitled only
-- while has_vanity_url_entitlement (AddOrganisationVanityUrlEntitlement) is
-- true. This is what makes a lapsed subscription's vanity host stop
-- resolving without touching vanity_slug itself -- the column keeps its
-- value, only the match condition goes false.
--
-- The opaque slug match (o.slug = p_slug) is untouched and unconditional --
-- it keeps working regardless of billing state, exactly as before this
-- migration.

SET lock_timeout = '5s';
SET statement_timeout = '30s';


CREATE OR REPLACE FUNCTION "public"."get_booking_organisation"("p_slug" "text")
    RETURNS TABLE("id" "uuid", "name" "text", "slug" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT o.id, o.name, o.slug
      FROM public.organisations o
      LEFT JOIN stripe.organisation_subscriptions s ON s.organisation_id = o.id
     WHERE o.slug = p_slug
        OR (o.vanity_slug = p_slug
            AND (o.subscription_status = 'grandfathered'
                 OR COALESCE(s.has_vanity_url_entitlement, false)))
     LIMIT 1;
$$;


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
    JOIN public.organisations o ON o.id = p.organisation_id
    LEFT JOIN stripe.organisation_subscriptions s ON s.organisation_id = o.id
    LEFT JOIN public.warehouse w ON w.id = p.warehouse_id
    JOIN LATERAL (
        SELECT ps.enums AS current_status
        FROM public.package_timeline pt
        JOIN public.package_status ps ON ps.id = pt.package_status
        WHERE pt.package_id = p.id
        ORDER BY pt.created_at DESC
        LIMIT 1
    ) latest ON true
    WHERE p.tracking_number = p_tracking_number
      AND (o.slug = p_slug
           OR (o.vanity_slug = p_slug
               AND (o.subscription_status = 'grandfathered'
                    OR COALESCE(s.has_vanity_url_entitlement, false))));

    RETURN v_result;  -- NULL when not found / wrong org
END;
$$;
