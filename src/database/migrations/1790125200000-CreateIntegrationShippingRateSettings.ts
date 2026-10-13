import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CreateIntegrationShippingRateSettings1790125200000 implements MigrationInterface {
    name = 'CreateIntegrationShippingRateSettings1790125200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1790125200000-create_integration_shipping_rate_settings.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."integration_shipping_rate_settings"`,
        );
        await queryRunner.query(`
            ALTER TABLE "public"."integration_location_mapping"
                DROP CONSTRAINT IF EXISTS "integration_location_mapping_address_chk",
                DROP COLUMN IF EXISTS "address"
        `);
        await queryRunner.query(`
            DELETE FROM "public"."user_permission"
            WHERE "permission_id" = (
                SELECT "id" FROM "public"."app_permission"
                WHERE "permission" = 'integrations.shipping_rates.write'
            )
        `);
        await queryRunner.query(`
            DELETE FROM "public"."app_permission"
            WHERE "permission" = 'integrations.shipping_rates.write'
        `);
    }
}
