import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddOrganisationTrial1786771922600 implements MigrationInterface {
    name = 'AddOrganisationTrial1786771922600';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1786771922600-add_organisation_trial.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // The UPDATE privilege narrowing in the .sql is deliberately NOT undone.
        // It restates the end state ReserveInfraSlugs already established, so
        // re-widening organisations back to a table-level GRANT here would undo
        // *that* migration's security fix as a side effect of reverting this one.
        // Dropping the column is what removes this migration's surface.

        // Reverse creation order: the trigger depends on the function, and both
        // depend on the column.
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "organisations_set_trial"
                ON "public"."organisations";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."set_organisation_trial"();
        `);
        // Dropping the column discards every recorded deadline, so re-running the
        // up migration afterwards restarts each surviving company org's trial from
        // scratch rather than restoring the original dates.
        await queryRunner.query(`
            ALTER TABLE "public"."organisations"
                DROP COLUMN IF EXISTS "trial_ends_at";
        `);
    }
}
