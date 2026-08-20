import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AddOrganisationPaymentMethodStatus1787000200000
    implements MigrationInterface
{
    name = 'AddOrganisationPaymentMethodStatus1787000200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000200000-add_organisation_payment_method_status.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "stripe"."organisation_subscriptions"
                DROP COLUMN IF EXISTS "has_payment_method";
        `);
    }
}
