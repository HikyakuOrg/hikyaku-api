import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
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

    const recordRow = {
        id: 'ledger-9',
        platform: 'shopify',
        event_type: 'order.paid',
        external_order_id: 'gid://shopify/Order/1',
        order_name: '#1001',
        status: 'needs_attention',
        error: 'Could not find it.',
        attempts: 1,
        customer_id: null,
        package_id: null,
        created_at: '2026-09-27T01:00:00.000Z',
        processed_at: '2026-09-27T01:00:05.000Z',
    };

    const recordDto = {
        id: 'ledger-9',
        platform: 'shopify',
        eventType: 'order.paid',
        externalOrderId: 'gid://shopify/Order/1',
        orderName: '#1001',
        status: 'needs_attention',
        error: 'Could not find it.',
        attempts: 1,
        customerId: null,
        packageId: null,
        createdAt: '2026-09-27T01:00:00.000Z',
        processedAt: '2026-09-27T01:00:05.000Z',
    };

    describe('listOrderEvents', () => {
        it('lists the org’s events, filtered by status, newest first', async () => {
            dataSource.query.mockResolvedValueOnce([recordRow]);

            const rows = await service.listOrderEvents(
                'org-1',
                'needs_attention',
                20,
            );

            expect(rows).toEqual([recordDto]);
            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain('ORDER BY created_at DESC');
            expect(params).toEqual(['org-1', 'needs_attention', 20]);
        });

        it('passes a null status to list every event', async () => {
            dataSource.query.mockResolvedValueOnce([
                { ...recordRow, processed_at: null },
            ]);

            const [row] = await service.listOrderEvents('org-1', undefined, 50);

            expect(row.processedAt).toBeNull();
            expect(dataSource.query.mock.calls[0][1]).toEqual([
                'org-1',
                null,
                50,
            ]);
        });
    });

    describe('retryOrderEvent', () => {
        it('re-queues a needs_attention or failed event with a fresh budget', async () => {
            dataSource.query.mockResolvedValueOnce([
                [{ ...recordRow, status: 'pending', error: null, attempts: 0 }],
                1,
            ]);

            const row = await service.retryOrderEvent('org-1', 'ledger-9');

            expect(row).toMatchObject({
                status: 'pending',
                error: null,
                attempts: 0,
            });
            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain("SET status = 'pending', attempts = 0");
            expect(params).toEqual([
                'ledger-9',
                'org-1',
                ['needs_attention', 'failed'],
            ]);
        });

        it('404s an event this organisation does not have', async () => {
            dataSource.query
                .mockResolvedValueOnce([[], 0])
                .mockResolvedValueOnce([]);

            await expect(
                service.retryOrderEvent('org-1', 'ledger-x'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('409s an event that is not waiting on a human', async () => {
            dataSource.query
                .mockResolvedValueOnce([[], 0])
                .mockResolvedValueOnce([{ status: 'processed' }]);

            await expect(
                service.retryOrderEvent('org-1', 'ledger-9'),
            ).rejects.toThrow(/this one is processed/);
        });
    });
});
