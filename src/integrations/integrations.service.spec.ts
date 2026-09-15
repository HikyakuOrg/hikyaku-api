import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import type { OrderEventDto } from './dto/order-event.dto';

describe('IntegrationsService', () => {
    let service: IntegrationsService;
    let dataSource: {
        query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
    };

    const dto = {
        event: {
            id: 'evt-1',
            type: 'order.paid',
            occurred_at: '2026-09-10T00:00:00Z',
            api_version: '2025-01',
        },
        source: { platform: 'shopify', app_version: '0.1.0' },
        order: { id: 'gid://shopify/Order/1' },
        customer: {},
        delivery: { required: true },
    } as unknown as OrderEventDto;

    beforeEach(async () => {
        dataSource = {
            query: jest.fn<Promise<unknown[]>, [string, unknown[]?]>(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IntegrationsService,
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();

        service = module.get<IntegrationsService>(IntegrationsService);
    });

    it('inserts a fresh event and returns its id, not replayed', async () => {
        dataSource.query
            .mockResolvedValueOnce([]) // findByIdempotencyKey: nothing yet
            .mockResolvedValueOnce([{ id: 'ledger-1' }]); // insert

        const { result, replayed } = await service.recordOrderEvent(
            'org-1',
            'idem-1',
            dto,
        );

        expect(replayed).toBe(false);
        expect(result).toEqual({ id: 'ledger-1' });

        const [lookupSql, lookupParams] = dataSource.query.mock.calls[0];
        expect(lookupSql).toContain(
            'WHERE organisation_id = $1 AND platform = $2 AND idempotency_key = $3',
        );
        expect(lookupParams).toEqual(['org-1', 'shopify', 'idem-1']);

        const [insertSql, insertParams] = dataSource.query.mock.calls[1];
        expect(insertSql).toContain(
            'INSERT INTO public.integration_order_event',
        );
        expect(insertParams).toEqual([
            'org-1',
            'shopify',
            'order.paid',
            'idem-1',
            'gid://shopify/Order/1',
            JSON.stringify(dto),
        ]);
    });

    it('replays the same row when the key and order id both match', async () => {
        dataSource.query.mockResolvedValueOnce([
            { id: 'ledger-2', external_order_id: 'gid://shopify/Order/1' },
        ]);

        const { result, replayed } = await service.recordOrderEvent(
            'org-1',
            'idem-2',
            dto,
        );

        expect(replayed).toBe(true);
        expect(result).toEqual({ id: 'ledger-2' });
        expect(dataSource.query).toHaveBeenCalledTimes(1); // no insert attempted
    });

    it('rejects with 409 when the key is reused for a different order', async () => {
        dataSource.query.mockResolvedValueOnce([
            { id: 'ledger-3', external_order_id: 'gid://shopify/Order/OTHER' },
        ]);

        await expect(
            service.recordOrderEvent('org-1', 'idem-3', dto),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('resolves a concurrent-insert race to the winner’s row instead of throwing', async () => {
        dataSource.query
            .mockResolvedValueOnce([]) // findByIdempotencyKey: nothing yet
            .mockRejectedValueOnce({ code: '23505' }) // insert loses the race
            .mockResolvedValueOnce([
                { id: 'ledger-4', external_order_id: 'gid://shopify/Order/1' },
            ]); // re-read finds the winner's row

        const { result, replayed } = await service.recordOrderEvent(
            'org-1',
            'idem-4',
            dto,
        );

        expect(replayed).toBe(true);
        expect(result).toEqual({ id: 'ledger-4' });
    });

    it('rethrows a non-unique-violation insert error', async () => {
        dataSource.query
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce({ code: '23503' }); // some other DB error

        await expect(
            service.recordOrderEvent('org-1', 'idem-5', dto),
        ).rejects.toEqual({ code: '23503' });
    });
});
