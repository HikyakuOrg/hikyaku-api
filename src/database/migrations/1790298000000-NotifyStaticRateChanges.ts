import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

const TABLES = [
    'service_areas',
    'driver_service_area',
    'drivers',
    'warehouse',
    'organisation_dispatch_settings',
    'integration_location_mapping',
    'integration_shipping_rate_settings',
];

export class NotifyStaticRateChanges1790298000000 implements MigrationInterface {
    name = 'NotifyStaticRateChanges1790298000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1790298000000-notify_static_rate_changes.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of TABLES) {
            await queryRunner.query(
                `DROP TRIGGER IF EXISTS "static_rates_changed" ON "public"."${table}"`,
            );
        }
        await queryRunner.query(
            `DROP FUNCTION IF EXISTS "public"."static_rates_changed_notify"()`,
        );
    }
}
