import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AddShiftLifecycleColumns1787100000000 implements MigrationInterface {
    name = 'AddShiftLifecycleColumns1787100000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100000000-add_shift_lifecycle_columns.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: triggers, then their functions, then the
        // indexes, then the constraints the columns carry, then the columns.
        // The backfill is not reversible -- the values it read from
        // request->'_meta' are still there, so re-running up() reproduces it.
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "package_timeline_dispatch_shift"
                ON "public"."package_timeline";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."dispatch_shift_on_in_transit"();
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "vrp_optimization_touch"
                ON "public"."vrp_optimization";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."vrp_optimization_touch"();
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."vrp_optimization_open_driver_day_idx";
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."vrp_optimization_open_vehicle_day_idx";
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."vrp_optimization_open_shift_idx";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."vrp_optimization"
                DROP CONSTRAINT IF EXISTS "vrp_optimization_warehouse_id_fkey",
                DROP CONSTRAINT IF EXISTS "vrp_optimization_vehicle_id_fkey",
                DROP CONSTRAINT IF EXISTS "vrp_optimization_driver_id_fkey",
                DROP CONSTRAINT IF EXISTS "vrp_optimization_status_check";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."vrp_optimization"
                DROP COLUMN IF EXISTS "updated_at",
                DROP COLUMN IF EXISTS "revision",
                DROP COLUMN IF EXISTS "completed_at",
                DROP COLUMN IF EXISTS "dispatched_at",
                DROP COLUMN IF EXISTS "shift_date",
                DROP COLUMN IF EXISTS "warehouse_id",
                DROP COLUMN IF EXISTS "vehicle_id",
                DROP COLUMN IF EXISTS "driver_id",
                DROP COLUMN IF EXISTS "status";
        `);
    }
}
