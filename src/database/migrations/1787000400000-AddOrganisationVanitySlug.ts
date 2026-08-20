import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AddOrganisationVanitySlug1787000400000
    implements MigrationInterface
{
    name = 'AddOrganisationVanitySlug1787000400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000400000-add_organisation_vanity_slug.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // The UPDATE privilege narrowing in the .sql is deliberately NOT undone,
        // same reasoning as AddOrganisationTrial's down() -- it restates the end
        // state ReserveInfraSlugs already established.

        // Reverse creation order: the trigger depends on the function, the
        // constraints and the function depend on the column.
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "organisations_set_vanity_slug"
                ON "public"."organisations";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."set_organisation_vanity_slug"();
        `);
        // Dropping the column takes every constraint on it with it, and discards
        // every recorded vanity slug -- re-running the up migration afterwards
        // regenerates them from each surviving company org's current name.
        await queryRunner.query(`
            ALTER TABLE "public"."organisations"
                DROP COLUMN IF EXISTS "vanity_slug";
        `);
    }
}
