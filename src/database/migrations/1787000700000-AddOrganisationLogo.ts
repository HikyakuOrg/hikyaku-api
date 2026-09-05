import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddOrganisationLogo1787000700000 implements MigrationInterface {
    name = 'AddOrganisationLogo1787000700000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000700000-add_organisation_logo.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restore the column-level grant to its pre-this-migration state
        // (name, org_type only) -- reverse creation order, same reasoning as
        // AddOrganisationVanitySlug's down().
        await queryRunner.query(`
            REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
        `);
        await queryRunner.query(`
            GRANT UPDATE ("name", "org_type") ON TABLE "public"."organisations" TO "authenticated";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."organisations"
                DROP COLUMN IF EXISTS "logo_url";
        `);
    }
}
