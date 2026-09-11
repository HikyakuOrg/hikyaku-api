import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddIntegrationsOrdersWritePermission1789261400000
    implements MigrationInterface
{
    name = 'AddIntegrationsOrdersWritePermission1789261400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1789261400000-add_integrations_orders_write_permission.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DELETE FROM "public"."user_permission"
            WHERE "permission_id" = (
                SELECT "id" FROM "public"."app_permission"
                WHERE "permission" = 'integrations.orders.write'
            );
        `);
        await queryRunner.query(`
            DELETE FROM "public"."app_permission"
            WHERE "permission" = 'integrations.orders.write';
        `);
    }
}
