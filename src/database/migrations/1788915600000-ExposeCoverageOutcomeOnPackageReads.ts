import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class ExposeCoverageOutcomeOnPackageReads1788915600000
    implements MigrationInterface
{
    name = 'ExposeCoverageOutcomeOnPackageReads1788915600000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1788915600000-expose_coverage_outcome_on_package_reads.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse of the up migration's own DROP-then-CREATE: drop the
        // 4/2-argument versions this migration added, then restore the
        // original 3/1-argument signatures verbatim (copied from
        // infra/db/schema.sql before this migration touched them) so a
        // revert leaves callers exactly where they started rather than with
        // no function at all.
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."get_packages_with_latest_status"(
                "p_statuses" "text"[], "p_limit" integer, "p_offset" integer, "p_coverage_outcomes" "text"[]
            );
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."get_packages_count"(
                "p_statuses" "text"[], "p_coverage_outcomes" "text"[]
            );
        `);

        await queryRunner.query(`
            CREATE FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[] DEFAULT NULL::"text"[], "p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "tracking_number" "text", "created_at" timestamp with time zone, "from_customer" "uuid", "to_customer" "uuid", "from_customer_name" "text", "to_customer_name" "text", "from_customer_address" "text", "to_customer_address" "text", "latest_package_status_text" "text", "latest_package_status_at" timestamp with time zone, "driver_id" "uuid", "driver_name" "text")
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
        `);
        await queryRunner.query(`
            ALTER FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer) OWNER TO "postgres";
        `);
        await queryRunner.query(`
            GRANT ALL ON FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer) TO "authenticated";
        `);
        await queryRunner.query(`
            GRANT ALL ON FUNCTION "public"."get_packages_with_latest_status"("p_statuses" "text"[], "p_limit" integer, "p_offset" integer) TO "service_role";
        `);

        await queryRunner.query(`
            CREATE FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) RETURNS bigint
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
        `);
        await queryRunner.query(`
            ALTER FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) OWNER TO "postgres";
        `);
        await queryRunner.query(`
            GRANT ALL ON FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) TO "authenticated";
        `);
        await queryRunner.query(`
            GRANT ALL ON FUNCTION "public"."get_packages_count"("p_statuses" "text"[]) TO "service_role";
        `);
    }
}
