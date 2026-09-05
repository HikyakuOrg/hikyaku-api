import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddShiftUsageMetering1787000300000 implements MigrationInterface {
    name = 'AddShiftUsageMetering1787000300000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000300000-add_shift_usage_metering.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: triggers depend on their functions, and
        // log_shift_usage_event's function depends on the outbox table.
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "vrp_optimization_shift_usage_log"
                ON "public"."vrp_optimization";
        `);
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "vrp_optimization_shift_allowance"
                ON "public"."vrp_optimization";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."log_shift_usage_event"();
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."enforce_shift_allowance"();
        `);
        await queryRunner.query(`
            DROP TABLE IF EXISTS "stripe"."shift_usage_events";
        `);
    }
}
