import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AllowUnknownDriverSpeed1787101100000
    implements MigrationInterface
{
    name = 'AllowUnknownDriverSpeed1787101100000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787101100000-allow_unknown_driver_speed.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Lossy, and unavoidably so: re-imposing NOT NULL requires every NULL to
        // become some number, and the reading it stands for was never recorded.
        // Collapsing "unknown" to 0 ("stationary") is the very assertion this
        // migration exists to avoid making -- it is accepted here only because
        // reverting to NOT NULL leaves no other option, and because nothing
        // reads the column. The row count is raised as a warning so a revert on
        // real data is not silent about how much of it was invented.
        await queryRunner.query(`
            DO $$
            DECLARE
                "backfilled" bigint;
            BEGIN
                UPDATE "public"."driver_current_location"
                SET "speed" = 0
                WHERE "speed" IS NULL;

                GET DIAGNOSTICS "backfilled" = ROW_COUNT;

                IF "backfilled" > 0 THEN
                    RAISE WARNING
                        'Reverting AllowUnknownDriverSpeed1787101100000: set speed = 0 on % driver_current_location row(s) whose speed was unknown.',
                        "backfilled";
                END IF;
            END
            $$;
        `);

        await queryRunner.query(`
            ALTER TABLE "public"."driver_current_location"
                ALTER COLUMN "speed" SET NOT NULL;
        `);

        // The column carried no comment before this migration.
        await queryRunner.query(`
            COMMENT ON COLUMN "public"."driver_current_location"."speed" IS NULL;
        `);
    }
}
