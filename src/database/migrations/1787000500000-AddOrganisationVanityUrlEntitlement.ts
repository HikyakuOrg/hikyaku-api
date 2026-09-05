import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddOrganisationVanityUrlEntitlement1787000500000 implements MigrationInterface {
    name = 'AddOrganisationVanityUrlEntitlement1787000500000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1787000500000-add_organisation_vanity_url_entitlement.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "stripe"."organisation_subscriptions"
                DROP COLUMN IF EXISTS "has_vanity_url_entitlement";
        `);
    }
}
