import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export const QUEUE_NAME = 'warehouse-optimization';

export interface PgmqMessage {
    msg_id: bigint;
    read_ct: number;
    enqueued_at: Date;
    vt: Date;
    message: Record<string, unknown>;
}

@Injectable()
export class QueueService {
    private readonly logger = new Logger(QueueService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) { }

    /**
     * Creates the pgmq queue only if it does not already exist.
     * pgmq.create() is NOT idempotent for queue names that require identifier
     * quoting (e.g. the hyphen in "warehouse-optimization"): on a second call it
     * re-runs ALTER EXTENSION ... ADD SEQUENCE and fails with SQLSTATE 55000.
     * Guarding with an existence check avoids that path.
     */
    async ensureQueue(): Promise<void> {
        const rows: { queue_name: string }[] = await this.dataSource.query(
            `SELECT queue_name FROM pgmq.list_queues() WHERE queue_name = $1`,
            [QUEUE_NAME],
        );
        if (rows.length === 0) {
            await this.dataSource.query(`SELECT pgmq.create($1)`, [QUEUE_NAME]);
            this.logger.log(`Queue "${QUEUE_NAME}" created.`);
        } else {
            this.logger.log(`Queue "${QUEUE_NAME}" already exists.`);
        }
    }

    /**
     * Sends a single nightly message to the queue (warehouse ID + run date).
     */
    async enqueue(warehouseId: string, runDate: string): Promise<void> {
        await this.dataSource.query(
            `SELECT pgmq.send($1, $2::jsonb)`,
            [QUEUE_NAME, JSON.stringify({ warehouseId, runDate })],
        );
    }

    /**
     * Sends an arbitrary payload onto the same queue. Used for on-demand runs,
     * which carry `{ kind: 'on_demand', ... }` so the consumer can tell them
     * apart from nightly `{ warehouseId, runDate }` messages.
     */
    async enqueuePayload(payload: Record<string, unknown>): Promise<void> {
        await this.dataSource.query(
            `SELECT pgmq.send($1, $2::jsonb)`,
            [QUEUE_NAME, JSON.stringify(payload)],
        );
    }

    /**
     * Reads at most one message from the queue, locking it for vtSeconds seconds
     * (visibility timeout). Returns null when the queue is empty.
     */
    async readOne(vtSeconds: number): Promise<PgmqMessage | null> {
        const rows: PgmqMessage[] = await this.dataSource.query(
            `SELECT * FROM pgmq.read($1, $2, 1)`,
            [QUEUE_NAME, vtSeconds],
        );
        return rows[0] ?? null;
    }

    /**
     * Moves a successfully processed message to the pgmq archive table for
     * long-term retention. Prefer this over delete() for audit purposes.
     */
    async archive(msgId: bigint): Promise<void> {
        await this.dataSource.query(`SELECT pgmq.archive($1::text, $2::bigint)`, [QUEUE_NAME, msgId]);
    }

    /**
     * Permanently deletes a message. Used after MAX_RETRIES is exceeded to
     * prevent a poison-pill message from cycling indefinitely.
     */
    async deleteMsg(msgId: bigint): Promise<void> {
        await this.dataSource.query(`SELECT pgmq.delete($1::text, $2::bigint)`, [QUEUE_NAME, msgId]);
    }
}
