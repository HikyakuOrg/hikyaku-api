import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class FixServiceAreaSchema1788656400000 implements MigrationInterface {
    name = 'FixServiceAreaSchema1788656400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1788656400000-fix_service_area_schema.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: RPCs, then the guards, then the bookkeeping
        // columns, then the name constraint, then the geometry type last, since
        // narrowing the type is the only step that can lose information and
        // should not run until everything reading the column is back.

        // ── 6. RPCs back to their original bodies (infra/db/schema.sql lines
        //       602-637): no is_deleted filter, no organisation_id column, and
        //       the service_role grant restored.
        await queryRunner.query(`
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
        `);
        await queryRunner.query(
            `COMMENT ON FUNCTION "public"."get_service_area_extent"() IS NULL`,
        );
        // PUBLIC is restored explicitly because CREATE OR REPLACE above kept the
        // ACL the up migration stripped; a plain CREATE would have re-granted it
        // by default.
        await queryRunner.query(
            `GRANT EXECUTE ON FUNCTION "public"."get_service_area_extent"() TO PUBLIC`,
        );
        await queryRunner.query(
            `GRANT ALL ON FUNCTION "public"."get_service_area_extent"() TO "authenticated"`,
        );
        await queryRunner.query(
            `GRANT ALL ON FUNCTION "public"."get_service_area_extent"() TO "service_role"`,
        );

        await queryRunner.query(
            `DROP FUNCTION IF EXISTS "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision)`,
        );
        await queryRunner.query(`
            CREATE FUNCTION "public"."get_service_areas_in_bounds"("p_min_lng" double precision, "p_min_lat" double precision, "p_max_lng" double precision, "p_max_lat" double precision) RETURNS TABLE("id" "uuid", "name" "text", "geometry" json)
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
        `);
        await queryRunner.query(
            `GRANT ALL ON FUNCTION "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision) TO "authenticated"`,
        );
        await queryRunner.query(
            `GRANT ALL ON FUNCTION "public"."get_service_areas_in_bounds"(double precision, double precision, double precision, double precision) TO "service_role"`,
        );

        // ── 5 & 4. Geometry guards.
        await queryRunner.query(`
            ALTER TABLE "public"."service_areas"
                DROP CONSTRAINT IF EXISTS "service_areas_geometry_extent_chk",
                DROP CONSTRAINT IF EXISTS "service_areas_geometry_area_chk",
                DROP CONSTRAINT IF EXISTS "service_areas_geometry_complexity_chk",
                DROP CONSTRAINT IF EXISTS "service_areas_geometry_valid_chk",
                DROP CONSTRAINT IF EXISTS "service_areas_geometry_srid_chk";
        `);
        await queryRunner.query(
            `COMMENT ON COLUMN "public"."service_areas"."geometry" IS NULL`,
        );

        // ── 3. Bookkeeping columns. Trigger before its function: the function
        //       cannot be dropped while the trigger depends on it, and CASCADE
        //       would be a blunter instrument than this revert is entitled to.
        await queryRunner.query(
            `DROP TRIGGER IF EXISTS "service_areas_touch" ON "public"."service_areas"`,
        );
        await queryRunner.query(
            `DROP FUNCTION IF EXISTS "public"."service_areas_touch"()`,
        );
        await queryRunner.query(`
            ALTER TABLE "public"."service_areas"
                DROP COLUMN IF EXISTS "is_deleted",
                DROP COLUMN IF EXISTS "updated_at",
                DROP COLUMN IF EXISTS "created_at";
        `);

        // ── 2. Name uniqueness back to global. This fails loudly if two
        //       organisations have since drawn areas with the same name, which
        //       is the correct outcome: the original globally-unique schema
        //       genuinely cannot represent that state, and picking a loser here
        //       would be data loss dressed up as a revert.
        await queryRunner.query(
            `DROP INDEX IF EXISTS "public"."service_areas_org_name_key"`,
        );
        await queryRunner.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'public.service_areas'::regclass
                       AND conname  = 'service_area_name_key'
                ) THEN
                    ALTER TABLE "public"."service_areas"
                        ADD CONSTRAINT "service_area_name_key" UNIQUE ("name");
                END IF;
            END;
            $$;
        `);

        // ── 1. MultiPolygon back to Polygon. Guarded, because ST_GeometryN(g,1)
        //       is only lossless for a single-part geometry: on a genuinely
        //       disjoint territory it would silently discard every lobe but the
        //       first, and a dispatcher would have no way to notice.
        await queryRunner.query(`
            DO $$
            DECLARE
                v_multipart bigint;
            BEGIN
                SELECT count(*)
                  INTO v_multipart
                  FROM public.service_areas
                 WHERE extensions.st_numgeometries("geometry") > 1;

                IF v_multipart > 0 THEN
                    RAISE EXCEPTION
                        'Cannot revert service_areas.geometry to Polygon: % row(s) hold more than one polygon, and narrowing the column would silently discard territory. Split or remove those areas first.',
                        v_multipart;
                END IF;
            END;
            $$;
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."service_areas"
                ALTER COLUMN "geometry" TYPE extensions.geometry(Polygon, 4326)
                USING extensions.st_geometryn("geometry", 1);
        `);
    }
}
