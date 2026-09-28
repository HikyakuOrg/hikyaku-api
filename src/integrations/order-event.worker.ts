import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PgNotifyService } from 'src/dispatch/pg-notify.service';
import {
    OrderEventProcessor,
    type ClaimedOrderEvent,
} from './order-event.processor';

/** Fired by the integration_order_event_notify trigger. */
export const ORDER_EVENT_CHANNEL = 'hikyaku_order_event';

/** Coalescing window for wake-ups, in ms. */
const DEBOUNCE_MS = 500;

/**
 * Backstop sweep, in ms. Catches a NOTIFY delivered to nobody (listener
 * reconnecting), a row whose retry backoff has elapsed, and a claim left
 * behind by a worker that died mid-row. Same reasoning as ReplanWorker's
 * SWEEP_MS.
 */
const SWEEP_MS = 60_000;

/** Rows claimed per pass. Each can spend seconds in Photon, so keep it small. */
const BATCH_SIZE = 5;

/** A claim older than this belongs to a worker that is gone. */
const STALE_CLAIM_MINUTES = 10;

/** Attempts before a row stops retrying and is marked failed. */
export const MAX_ATTEMPTS = 5;

/** Delay before retry n (1-based), in seconds: 1m, 5m, 15m, 1h. */
const BACKOFF_SECONDS = [60, 300, 900, 3600];

/**
 * Drains integration_order_event: claims due rows and hands each to
 * OrderEventProcessor.
 *
 * The ledger is the queue. Claiming is one UPDATE ... FOR UPDATE SKIP LOCKED,
 * so replicas never take the same row, and a claim carries a timestamp so a
 * row whose worker crashed is taken again after STALE_CLAIM_MINUTES rather
 * than stuck in `processing` forever.
 */
@Injectable()
export class OrderEventWorker
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private readonly logger = new Logger(OrderEventWorker.name);
    private sweepTimer: NodeJS.Timeout | null = null;
    private draining = false;
    private pendingDrain = false;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly notify: PgNotifyService,
        private readonly processor: OrderEventProcessor,
    ) {}

    onApplicationBootstrap(): void {
        this.notify.subscribe({
            channel: ORDER_EVENT_CHANNEL,
            debounceMs: DEBOUNCE_MS,
            // The payload (a row id) is ignored: the table is the work list.
            onWake: () => this.drain(),
        });

        this.sweepTimer = setInterval(() => void this.drain(), SWEEP_MS);
        this.sweepTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
    }

    /** Single-flight, like ReplanWorker.drain. */
    async drain(): Promise<void> {
        if (this.draining) {
            this.pendingDrain = true;
            return;
        }
        this.draining = true;
        try {
            do {
                this.pendingDrain = false;
                while (await this.drainOnce()) {
                    // Keep going while full batches come back.
                }
            } while (this.pendingDrain);
        } finally {
            this.draining = false;
        }
    }

    /** Processes one batch. True when the batch was full and more may wait. */
    private async drainOnce(): Promise<boolean> {
        let rows: ClaimedOrderEvent[];
        try {
            rows = await this.claim();
        } catch (err: unknown) {
            this.logger.warn(`Order event claim failed: ${String(err)}`);
            return false;
        }

        for (const row of rows) {
            try {
                const outcome = await this.processor.process(row);
                this.logger.log(
                    `Order event ${row.id} (${row.payload.order?.name ?? row.id}): ${outcome.status}` +
                        (outcome.status === 'processed'
                            ? ` -> package ${outcome.packageIds.join(', ')}`
                            : ` (${outcome.error})`),
                );
            } catch (err: unknown) {
                await this.fail(row, err);
            }
        }

        return rows.length === BATCH_SIZE;
    }

    private async claim(): Promise<ClaimedOrderEvent[]> {
        // UPDATE ... RETURNING through TypeORM resolves to [rows, rowCount].
        const [rows]: [ClaimedOrderEvent[], number] =
            await this.dataSource.query(
                `UPDATE public.integration_order_event e
                SET status = 'processing', claimed_at = now(), attempts = e.attempts + 1
              WHERE e.id IN (
                    SELECT id FROM public.integration_order_event
                     WHERE (status = 'pending' AND next_attempt_at <= now())
                        OR (status = 'processing'
                            AND claimed_at < now() - make_interval(mins => $2))
                     ORDER BY next_attempt_at
                     LIMIT $1
                       FOR UPDATE SKIP LOCKED
              )
              RETURNING e.id, e.organisation_id, e.platform, e.event_type, e.payload, e.attempts`,
                [BATCH_SIZE, STALE_CLAIM_MINUTES],
            );
        return rows;
    }

    /**
     * A transient failure: back to pending with a backoff, or failed once the
     * attempts run out. The error is kept either way, so a row waiting for its
     * next attempt still says why.
     */
    private async fail(row: ClaimedOrderEvent, err: unknown): Promise<void> {
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = row.attempts >= MAX_ATTEMPTS;
        const delay =
            BACKOFF_SECONDS[
                Math.min(row.attempts, BACKOFF_SECONDS.length) - 1
            ] ?? BACKOFF_SECONDS[0];

        if (exhausted) {
            this.logger.error(
                `Order event ${row.id} failed after ${row.attempts} attempts: ${message}`,
            );
        } else {
            this.logger.warn(
                `Order event ${row.id} attempt ${row.attempts} failed, retrying in ${delay}s: ${message}`,
            );
        }

        try {
            await this.dataSource.query(
                `UPDATE public.integration_order_event
                    SET status = $2, error = $3, claimed_at = NULL,
                        next_attempt_at = now() + make_interval(secs => $4),
                        processed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
                  WHERE id = $1`,
                [row.id, exhausted ? 'failed' : 'pending', message, delay],
            );
        } catch (writeErr: unknown) {
            // The claim goes stale and the row is taken again later.
            this.logger.error(
                `Could not record the failure of order event ${row.id}: ${String(writeErr)}`,
            );
        }
    }
}
