import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class PackagePerFulfillmentGroup1789952400000 implements MigrationInterface {
    name = 'PackagePerFulfillmentGroup1789952400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789952400000-package_per_fulfillment_group.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restoring one package per order fails while any order already has
        // more than one. That is deliberate: which of them to keep is a
        // decision for a person, not for a revert.
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "packages_org_external_order_key"
                ON "public"."packages" ("organisation_id", "external_platform", "external_order_id")
                WHERE "external_order_id" IS NOT NULL;
            DROP INDEX IF EXISTS "public"."packages_org_external_fulfillment_key";
            ALTER TABLE "public"."packages"
                DROP CONSTRAINT IF EXISTS "packages_external_fulfillment_check",
                DROP COLUMN IF EXISTS "external_fulfillment_id";

            DROP TABLE IF EXISTS "public"."integration_order_event_package";

            COMMENT ON COLUMN "public"."packages"."external_order_id" IS
                'The order''s id in the storefront (Shopify: its GraphQL global id). Unique per organisation and platform.';
            COMMENT ON COLUMN "public"."integration_order_event"."package_id" IS NULL;
            COMMENT ON COLUMN "public"."integration_order_event"."status" IS
                'Processing state. pending: waiting for the worker (again, after a transient failure, once next_attempt_at passes). processing: claimed by a worker at claimed_at. processed: package_id/customer_id say what it produced. skipped: nothing to deliver (digital or pickup-only order, or an event type that creates nothing); error says why. needs_attention: cannot be processed without a human (ungeocodable address, no warehouse); error says why, and POST /api/v1/integrations/orders/:id/retry re-queues it. failed: transient failures exhausted the retry budget.';
        `);
    }
}
