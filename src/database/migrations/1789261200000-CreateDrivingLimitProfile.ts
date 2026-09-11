import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CreateDrivingLimitProfile1789261200000 implements MigrationInterface {
    name = 'CreateDrivingLimitProfile1789261200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789261200000-create_driving_limit_profile.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse order. The trigger function is reverted to its
        // pre-migration body first, so no UPDATE on drivers can run against a
        // function that still references a column about to be dropped.
        await queryRunner.query(`
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
        `);

        // Dropping each column takes its own FK constraint and index with it.
        await queryRunner.query(`
            ALTER TABLE "public"."drivers"
                DROP COLUMN IF EXISTS "driving_limit_profile_id";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."organisations"
                DROP COLUMN IF EXISTS "default_driving_limit_profile_id";
        `);

        // The table takes its own policies, indexes and trigger with it.
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."driving_limit_profile"`,
        );
        await queryRunner.query(
            `DROP FUNCTION IF EXISTS "public"."driving_limit_profile_touch"()`,
        );
    }
}
