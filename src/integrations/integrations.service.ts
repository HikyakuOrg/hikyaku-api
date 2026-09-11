import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OrderEventDto } from './dto/order-event.dto';

interface LedgerRow {
    id: string;
    external_order_id: string;
}

/**
 * Record-only ingestion for external order events (HIK-99, phase 1). Stores
 * every event in `integration_order_event`, keyed by
 * `(organisation_id, platform, idempotency_key)`, and nothing else — no
 * customer or package is created from it yet.
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
}
