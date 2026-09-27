import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderEventDto } from './dto/order-event.dto';
import type {
    OrderEventRecordDto,
    OrderEventStatus,
} from './dto/recorded-order-event.dto';

interface LedgerRow {
    id: string;
    external_order_id: string;
}

interface RecordRow {
    id: string;
    platform: string;
    event_type: string;
    external_order_id: string;
    order_name: string | null;
    status: OrderEventStatus;
    error: string | null;
    attempts: number;
    customer_id: string | null;
    package_id: string | null;
    created_at: string;
    processed_at: string | null;
}

const RECORD_COLS = `id, platform, event_type, external_order_id,
    payload->'order'->>'name' AS order_name, status, error, attempts,
    customer_id, package_id, created_at, processed_at`;

/** Statuses a human can send back to the worker. */
const RETRYABLE: OrderEventStatus[] = ['needs_attention', 'failed'];

/**
 * Ingestion for external order events. Recording stores every event in
 * `integration_order_event`, keyed by
 * `(organisation_id, platform, idempotency_key)`, and returns: the customer
 * and package are made afterwards by OrderEventWorker, which a trigger on the
 * insert wakes. This service also reads the ledger back for the dashboard
 * and re-queues events a human has fixed.
 */
@Injectable()
export class IntegrationsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /**
     * New key -> insert, return 201. Same key + same order id -> 200 replay
     * of the existing row. Same key + a different order id -> 409, the key
     * has already been spent on another order. A race between two callers on
     * the same new key resolves to the same row: the loser's insert hits the
     * unique index (23505) and is re-read rather than erroring, the same
     * pattern PackagesService uses for tracking numbers.
     */
    async recordOrderEvent(
        organisationId: string,
        idempotencyKey: string,
        dto: OrderEventDto,
    ): Promise<{ result: { id: string }; replayed: boolean }> {
        const platform = dto.source.platform;
        const externalOrderId = dto.order.id;

        const existing = await this.findByIdempotencyKey(
            organisationId,
            platform,
            idempotencyKey,
        );
        if (existing) {
            return this.replayOrConflict(existing, externalOrderId);
        }

        try {
            const inserted = await this.insert(
                organisationId,
                platform,
                idempotencyKey,
                externalOrderId,
                dto,
            );
            return { result: { id: inserted.id }, replayed: false };
        } catch (err) {
            if ((err as { code?: string })?.code !== '23505') throw err;

            const raced = await this.findByIdempotencyKey(
                organisationId,
                platform,
                idempotencyKey,
            );
            if (!raced) throw err; // Lost the race but the winner's row is gone — unexpected; surface the original error.
            return this.replayOrConflict(raced, externalOrderId);
        }
    }

    private replayOrConflict(
        row: LedgerRow,
        externalOrderId: string,
    ): { result: { id: string }; replayed: boolean } {
        if (row.external_order_id !== externalOrderId) {
            throw new ConflictException(
                'This Idempotency-Key was already used for a different order.',
            );
        }
        return { result: { id: row.id }, replayed: true };
    }

    private async findByIdempotencyKey(
        organisationId: string,
        platform: string,
        idempotencyKey: string,
    ): Promise<LedgerRow | null> {
        const rows: LedgerRow[] = await this.dataSource.query(
            `SELECT id, external_order_id FROM public.integration_order_event
             WHERE organisation_id = $1 AND platform = $2 AND idempotency_key = $3`,
            [organisationId, platform, idempotencyKey],
        );
        return rows[0] ?? null;
    }

    private async insert(
        organisationId: string,
        platform: string,
        idempotencyKey: string,
        externalOrderId: string,
        dto: OrderEventDto,
    ): Promise<{ id: string }> {
        const rows: { id: string }[] = await this.dataSource.query(
            `INSERT INTO public.integration_order_event
                (organisation_id, platform, event_type, idempotency_key, external_order_id, payload)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING id`,
            [
                organisationId,
                platform,
                dto.event.type,
                idempotencyKey,
                externalOrderId,
                JSON.stringify(dto),
            ],
        );
        return rows[0];
    }

    /** Recent events, newest first, optionally only those in one status. */
    async listOrderEvents(
        organisationId: string,
        status: OrderEventStatus | undefined,
        limit: number,
    ): Promise<OrderEventRecordDto[]> {
        const rows: RecordRow[] = await this.dataSource.query(
            `SELECT ${RECORD_COLS} FROM public.integration_order_event
              WHERE organisation_id = $1 AND ($2::text IS NULL OR status = $2)
              ORDER BY created_at DESC
              LIMIT $3`,
            [organisationId, status ?? null, limit],
        );
        return rows.map((row) => this.toRecordDto(row));
    }

    /**
     * Sends a `needs_attention` or `failed` event back to the worker, with a
     * fresh attempt budget: the person retrying has presumably fixed the
     * cause (corrected the address, added a warehouse). The status change
     * fires the wake-up trigger, so it is picked up at once.
     */
    async retryOrderEvent(
        organisationId: string,
        eventId: string,
    ): Promise<OrderEventRecordDto> {
        const [rows]: [RecordRow[], number] = await this.dataSource.query(
            `UPDATE public.integration_order_event
                SET status = 'pending', attempts = 0, next_attempt_at = now(),
                    error = NULL, processed_at = NULL, claimed_at = NULL
              WHERE id = $1 AND organisation_id = $2 AND status = ANY($3::text[])
              RETURNING ${RECORD_COLS}`,
            [eventId, organisationId, RETRYABLE],
        );
        if (rows[0]) return this.toRecordDto(rows[0]);

        const current: { status: string }[] = await this.dataSource.query(
            `SELECT status FROM public.integration_order_event
              WHERE id = $1 AND organisation_id = $2`,
            [eventId, organisationId],
        );
        if (!current[0]) throw new NotFoundException('Order event not found.');
        throw new ConflictException(
            `Only an order event that needs attention or has failed can be retried; this one is ${current[0].status}.`,
        );
    }

    private toRecordDto(row: RecordRow): OrderEventRecordDto {
        return {
            id: row.id,
            platform: row.platform,
            eventType: row.event_type,
            externalOrderId: row.external_order_id,
            orderName: row.order_name,
            status: row.status,
            error: row.error,
            attempts: row.attempts,
            customerId: row.customer_id,
            packageId: row.package_id,
            createdAt: new Date(row.created_at).toISOString(),
            processedAt: row.processed_at
                ? new Date(row.processed_at).toISOString()
                : null,
        };
    }
}
