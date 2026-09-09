import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddAssignmentCoverageOutcome1788829200000 implements MigrationInterface {
    name = 'AddAssignmentCoverageOutcome1788829200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1788829200000-add_assignment_coverage_outcome.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order. Dropping the column would take the constraint
        // and the index with it, but they are named explicitly so that a
        // partially applied `up` (the column added, the constraint not) reverts
        // cleanly instead of failing on the first missing object.
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."package_assignment_coverage_outcome_idx";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."package_assignment"
                DROP CONSTRAINT IF EXISTS "package_assignment_coverage_outcome_chk";
        `);

        // Destructive, and worth naming: this is the only record of which
        // coverage step placed each package, and nothing can reconstruct it
        // afterwards because none of the inputs to that decision are versioned.
        // Reverting is still the right behaviour for a down migration; it is
        // just not a free one.
        await queryRunner.query(`
            ALTER TABLE "public"."package_assignment"
                DROP COLUMN IF EXISTS "coverage_outcome";
        `);
    }
}
