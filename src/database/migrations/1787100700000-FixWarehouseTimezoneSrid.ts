import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class FixWarehouseTimezoneSrid1787100700000 implements MigrationInterface {
    name = 'FixWarehouseTimezoneSrid1787100700000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100700000-fix_warehouse_timezone_srid.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores the pre-fix body from AssignmentBookkeeping1787100300000,
        // which trusted tz.geom's stored SRID instead of relabelling it.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."set_warehouse_timezone"()
                RETURNS trigger
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = ''
            AS $$
            DECLARE
                v_tzid text;
            BEGIN
                SELECT tz.tzid
                  INTO v_tzid
                  FROM tzdata.timezone tz
                 WHERE extensions.st_within(
                           extensions.st_setsrid(NEW.warehouse_location, 4326),
                           tz.geom
                       )
                 LIMIT 1;

                NEW.timezone := COALESCE(v_tzid, 'UTC');
                RETURN NEW;
            END;
            $$;
        `);
        await queryRunner.query(`
            COMMENT ON FUNCTION "public"."set_warehouse_timezone"() IS
                'Resolves warehouse.timezone from tzdata.timezone by point-in-polygon whenever warehouse_location is written. Replaces the hourly in-memory cache the nightly scheduler kept.';
        `);
    }
}
