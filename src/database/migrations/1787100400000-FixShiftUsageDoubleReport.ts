import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class FixShiftUsageDoubleReport1787100400000 implements MigrationInterface {
    name = 'FixShiftUsageDoubleReport1787100400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100400000-fix_shift_usage_double_report.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order. The trigger itself is not touched by up() --
        // only the function body it calls -- so restoring the pre-notify body is
        // enough to undo it.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."log_shift_usage_event"()
                RETURNS trigger
                LANGUAGE plpgsql
                SECURITY DEFINER
                SET search_path = ''
            AS $$
            BEGIN
                IF NEW.organisation_id IS NOT NULL THEN
                    INSERT INTO stripe.shift_usage_events (organisation_id, vrp_optimization_id)
                    VALUES (NEW.organisation_id, NEW.id);
                END IF;
                RETURN NEW;
            END;
            $$;
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "stripe"."shift_usage_events_claimable_idx";
        `);
        await queryRunner.query(`
            ALTER TABLE "stripe"."shift_usage_events"
                DROP COLUMN IF EXISTS "reporting_started_at";
        `);
    }
}
