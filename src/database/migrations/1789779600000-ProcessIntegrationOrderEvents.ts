import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class ProcessIntegrationOrderEvents1789779600000 implements MigrationInterface {
    name = 'ProcessIntegrationOrderEvents1789779600000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789779600000-process_integration_order_events.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Keeps packages made from orders, but drops their order reference.
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."packages_org_external_order_key";
            ALTER TABLE "public"."packages"
                DROP CONSTRAINT IF EXISTS "packages_external_order_check",
                DROP COLUMN IF EXISTS "external_order_name",
                DROP COLUMN IF EXISTS "external_order_id",
                DROP COLUMN IF EXISTS "external_platform";

            DROP TRIGGER IF EXISTS "integration_order_event_notify" ON "public"."integration_order_event";
            DROP FUNCTION IF EXISTS "public"."integration_order_event_notify"();

            DROP INDEX IF EXISTS "public"."integration_order_event_org_status_idx";
            DROP INDEX IF EXISTS "public"."integration_order_event_work_idx";
            ALTER TABLE "public"."integration_order_event"
                DROP CONSTRAINT IF EXISTS "integration_order_event_package_id_fkey",
                DROP CONSTRAINT IF EXISTS "integration_order_event_customer_id_fkey",
                DROP CONSTRAINT IF EXISTS "integration_order_event_status_check",
                DROP COLUMN IF EXISTS "error",
                DROP COLUMN IF EXISTS "package_id",
                DROP COLUMN IF EXISTS "customer_id",
                DROP COLUMN IF EXISTS "processed_at",
                DROP COLUMN IF EXISTS "claimed_at",
                DROP COLUMN IF EXISTS "next_attempt_at",
                DROP COLUMN IF EXISTS "attempts",
                DROP COLUMN IF EXISTS "status";

            COMMENT ON TABLE "public"."integration_order_event" IS
                'Durable, idempotent ledger of inbound order events from external storefronts (Shopify today; WooCommerce/Magento/MedusaJS later). Record-only for phase 1 -- no link to a customer or package yet. See src/integrations/.';
        `);
    }
}
