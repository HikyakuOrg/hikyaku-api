import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class RenameCustomerShopifyIdToExternal1789261200000
    implements MigrationInterface
{
    name = 'RenameCustomerShopifyIdToExternal1789261200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1789261200000-rename_customer_shopify_id_to_external.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."customer_org_external_idx";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."customer"
                DROP CONSTRAINT IF EXISTS "customer_external_platform_id_check";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."customer"
                DROP COLUMN IF EXISTS "external_platform";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."customer"
                RENAME COLUMN "external_customer_id" TO "shopify_customer_id";
        `);
        await queryRunner.query(`
            CREATE INDEX "customer_shopify_customer_id_idx"
                ON "public"."customer" USING "btree" ("shopify_customer_id")
                WHERE ("shopify_customer_id" IS NOT NULL);
        `);
    }
}
