import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class TouchDriverCurrentLocationUpdatedAt1787101000000 implements MigrationInterface {
    name = 'TouchDriverCurrentLocationUpdatedAt1787101000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1787101000000-touch_driver_current_location_updated_at.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Back to the broken-but-original behaviour: updated_at stays at its
        // INSERT-time default. Trigger first -- the function cannot be dropped
        // while it depends on it, and dropping with CASCADE here would be a
        // blunter instrument than this migration is entitled to use.
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "trg_driver_current_location_touch"
                ON "public"."driver_current_location";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."driver_current_location_touch"();
        `);
    }
}
