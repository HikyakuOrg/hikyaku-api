import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

export const QUEUE_NAME = 'warehouse-optimization';

/** The channel ReplanWorker listens on. NOTIFY is the wake; pgmq is the truth. */
export const REPLAN_CHANNEL = 'hikyaku_shift_replan';

export interface PgmqMessage {
    msg_id: bigint;
    read_ct: number;
    enqueued_at: Date;
    vt: Date;
    message: Record<string, unknown>;
}

/** Ask Tier 2 to re-solve one shift with real time windows. */
export interface ReplanPayload {
    kind: 'replan';
    optimisationId: string;
    warehouseId: string;
    organisationId: string;
}

/**
 * The queue survives the scheduler.
 *
 * It stops being polled and starts being woken, but LISTEN/NOTIFY alone cannot
 * replace it: a notification fired while the listener is reconnecting is
 * delivered to nobody, and a replan that crashes mid-solve leaves no trace. pgmq
 * supplies exactly the four things that would otherwise have to be rebuilt —
 * visibility-timeout retry, safe consumption across replicas, an archive for
 * audit, and durability across a restart.
 */
@Injectable()
export class QueueService {
    private readonly logger = new Logger(QueueService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
     * Sends an arbitrary payload onto the queue. Used for on-demand runs, which
     * carry `{ kind: 'on_demand', ... }`, and for replans, which carry
     * `{ kind: 'replan', ... }`.
     */
    async enqueuePayload(payload: Record<string, unknown>): Promise<void> {
        await this.dataSource.query(`SELECT pgmq.send($1, $2::jsonb)`, [
            QUEUE_NAME,
            JSON.stringify(payload),
        ]);
    }

    /**
     * Enqueues a replan AND fires the wake-up notification, both on the caller's
     * open transaction.
     *
     * Inside the transaction on purpose: a rolled-back assignment must not leave
     * a queued replan for a plan that never happened, and a committed one must
     * never be missed because the send landed after the commit and the process
     * died in between. Postgres holds NOTIFY until COMMIT for the same reason.
     */
    async enqueueReplan(
        runner: QueryRunner,
        payload: ReplanPayload,
    ): Promise<void> {
        await runner.query(`SELECT pgmq.send($1, $2::jsonb)`, [
            QUEUE_NAME,
            JSON.stringify(payload),
        ]);
        await runner.query(`SELECT pg_notify($1, $2)`, [
            REPLAN_CHANNEL,
            payload.optimisationId,
        ]);
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
     * Reads up to `limit` messages, each invisible to other readers for
     * `vtSeconds`. Batching is what makes a coalesced drain cheap: a 500-package
     * import queues 500 replans for a handful of shifts, and reading them one
     * round-trip at a time would cost more than the solves.
     */
    async readBatch(vtSeconds: number, limit: number): Promise<PgmqMessage[]> {
        return this.dataSource.query(`SELECT * FROM pgmq.read($1, $2, $3)`, [
            QUEUE_NAME,
            vtSeconds,
            limit,
        ]);
    }

    /**
     * Moves a successfully processed message to the pgmq archive table for
     * long-term retention. Prefer this over delete() for audit purposes.
     */
    async archive(msgId: bigint): Promise<void> {
        await this.dataSource.query(
            `SELECT pgmq.archive($1::text, $2::bigint)`,
            [QUEUE_NAME, msgId],
        );
    }

    /**
     * Permanently deletes a message. Used after MAX_RETRIES is exceeded to
     * prevent a poison-pill message from cycling indefinitely.
     */
    async deleteMsg(msgId: bigint): Promise<void> {
        await this.dataSource.query(
            `SELECT pgmq.delete($1::text, $2::bigint)`,
            [QUEUE_NAME, msgId],
        );
    }
}
