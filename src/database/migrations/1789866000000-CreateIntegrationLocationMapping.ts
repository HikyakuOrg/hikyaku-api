import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CreateIntegrationLocationMapping1789866000000 implements MigrationInterface {
    name = 'CreateIntegrationLocationMapping1789866000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789866000000-create_integration_location_mapping.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // The table takes its trigger and foreign keys with it, which is what
        // frees warehouse_organisation_id_id_key to be dropped.
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."integration_location_mapping"`,
        );
        await queryRunner.query(
            `DROP FUNCTION IF EXISTS "public"."integration_location_mapping_unmap_deleted_warehouse"()`,
        );
        await queryRunner.query(`
            ALTER TABLE "public"."warehouse"
                DROP CONSTRAINT IF EXISTS "warehouse_organisation_id_id_key"
        `);
        await queryRunner.query(`
            DELETE FROM "public"."user_permission"
            WHERE "permission_id" = (
                SELECT "id" FROM "public"."app_permission"
                WHERE "permission" = 'integrations.locations.write'
            )
        `);
        await queryRunner.query(`
            DELETE FROM "public"."app_permission"
            WHERE "permission" = 'integrations.locations.write'
        `);
    }
}
