import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CreateOrganisationSubscriptions1787000100000 implements MigrationInterface {
    name = 'CreateOrganisationSubscriptions1787000100000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000100000-create_organisation_subscriptions.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP TABLE IF EXISTS "stripe"."organisation_subscriptions";
        `);
    }
}
