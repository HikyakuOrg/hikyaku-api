import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddPackageShippingRate1790211600000 implements MigrationInterface {
    name = 'AddPackageShippingRate1790211600000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1790211600000-add_package_shipping_rate.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "public"."packages"
                DROP CONSTRAINT IF EXISTS "packages_shipping_rate_check",
                DROP COLUMN IF EXISTS "shipping_service_id",
                DROP COLUMN IF EXISTS "shipping_service_name",
                DROP COLUMN IF EXISTS "shipping_price_minor",
                DROP COLUMN IF EXISTS "shipping_discounted_price_minor",
                DROP COLUMN IF EXISTS "shipping_currency",
                DROP COLUMN IF EXISTS "shipping_rate_path"
        `);
    }
}
