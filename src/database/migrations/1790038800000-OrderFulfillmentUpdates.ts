import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class OrderFulfillmentUpdates1790038800000 implements MigrationInterface {
    name = 'OrderFulfillmentUpdates1790038800000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1790038800000-order_fulfillment_updates.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS "public"."integration_order_event_order_idx";

            COMMENT ON COLUMN "public"."integration_order_event"."event_type" IS NULL;
            COMMENT ON COLUMN "public"."integration_order_event"."status" IS
                'Processing state. pending: waiting for the worker (again, after a transient failure, once next_attempt_at passes). processing: claimed by a worker at claimed_at. processed: integration_order_event_package and customer_id say what it produced. skipped: nothing to deliver (digital or pickup-only order, every group picked up or from a location Hikyaku does not deliver for, or an event type that creates nothing); error says why. needs_attention: cannot be fully processed without a human (ungeocodable address, no warehouse, a fulfillment location not mapped to a warehouse); error says why, the groups that could be processed already have their packages, and POST /api/v1/integrations/orders/:id/retry re-queues the rest. failed: transient failures exhausted the retry budget.';
        `);
    }
}
