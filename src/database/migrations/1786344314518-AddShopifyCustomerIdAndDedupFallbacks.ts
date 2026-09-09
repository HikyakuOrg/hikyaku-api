import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddShopifyCustomerIdAndDedupFallbacks1786344314518 implements MigrationInterface {
    name = 'AddShopifyCustomerIdAndDedupFallbacks1786344314518';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1786344314518-add_shopify_customer_id_and_dedup_fallbacks.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."customer_org_name_unique";
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."customer_org_email_unique";
        `);
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."customer_shopify_customer_id_idx";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."customer" DROP COLUMN "shopify_customer_id";
        `);
    }
}
