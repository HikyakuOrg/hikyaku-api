import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class ResolveOrganisationsByVanitySlug1787000600000
    implements MigrationInterface
{
    name = 'ResolveOrganisationsByVanitySlug1787000600000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000600000-resolve_organisations_by_vanity_slug.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores each function's pre-migration definition exactly (the
        // canonical-slug-only match), rather than dropping them -- both
        // functions predate this migration and other code depends on them
        // existing.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."get_booking_organisation"("p_slug" "text")
                RETURNS TABLE("id" "uuid", "name" "text", "slug" "text")
                LANGUAGE "sql" STABLE SECURITY DEFINER
                SET "search_path" TO 'public'
                AS $$
                SELECT o.id, o.name, o.slug
                FROM public.organisations o
                WHERE o.slug = p_slug;
            $$;
        `);

        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."get_tracking_details"("p_tracking_number" "text", "p_slug" "text") RETURNS "jsonb"
                LANGUAGE "plpgsql" STABLE SECURITY DEFINER
                SET "search_path" TO 'public', 'extensions'
                AS $$
            DECLARE
                v_result jsonb;  -- not \`v\`: vehicles is aliased \`v\` in a subquery below
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

                RETURN v_result;
            END;
            $$;
        `);
    }
}
