import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AssignmentBookkeeping1787100300000 implements MigrationInterface {
    name = 'AssignmentBookkeeping1787100300000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100300000-assignment_bookkeeping.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: policy before its table, trigger before its
        // function, and every column last. The rows the dedupe removed are gone
        // for good -- there is no record of a duplicate driver/vehicle pairing
        // to restore, and re-creating one would be inventing data.
        await queryRunner.query(`
            DROP POLICY IF EXISTS "vrp optimization revision select org"
                ON "public"."vrp_optimization_revision";
        `);
        await queryRunner.query(`
            DROP TABLE IF EXISTS "public"."vrp_optimization_revision";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."driver_vehicle_assignment"
                DROP CONSTRAINT IF EXISTS "driver_vehicle_assignment_driver_vehicle_key";
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "warehouse_set_timezone" ON "public"."warehouse";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."set_warehouse_timezone"();
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."warehouse" DROP COLUMN IF EXISTS "timezone";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."packages" DROP COLUMN IF EXISTS "eviction_count";
        `);
    }
}
