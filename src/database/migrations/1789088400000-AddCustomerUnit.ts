import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddCustomerUnit1789088400000 implements MigrationInterface {
    name = 'AddCustomerUnit1789088400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789088400000-add_customer_unit.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // No data was written by `up` (nullable, no default, no backfill), so
        // dropping the column loses only units captured between up and revert.
        await queryRunner.query(`
            ALTER TABLE "public"."customer" DROP COLUMN IF EXISTS "customer_unit";
        `);
    }
}
