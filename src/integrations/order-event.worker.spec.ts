import { DataSource } from 'typeorm';
import {
    PgNotifyService,
    type NotifySubscription,
} from 'src/dispatch/pg-notify.service';
import type { OrderEventDto } from './dto/order-event.dto';
import {
    OrderEventProcessor,
    type ClaimedOrderEvent,
    type OrderEventOutcome,
} from './order-event.processor';
import {
    MAX_ATTEMPTS,
    ORDER_EVENT_CHANNEL,
    OrderEventWorker,
} from './order-event.worker';

const row = (id: string, attempts = 1): ClaimedOrderEvent => ({
    id,
    organisation_id: 'org-1',
    platform: 'shopify',
    event_type: 'order.paid',
    payload: { order: { name: `#${id}` } } as unknown as OrderEventDto,
    attempts,
});

describe('OrderEventWorker', () => {
    let batches: ClaimedOrderEvent[][];
    let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
    let notify: { subscribe: jest.Mock<void, [NotifySubscription]> };
    let processor: {
        process: jest.Mock<Promise<OrderEventOutcome>, [ClaimedOrderEvent]>;
    };
    let worker: OrderEventWorker;

    const failureWrites = () =>
        query.mock.calls.filter(([sql]) =>
            sql.includes('next_attempt_at = now() + make_interval'),
        );

    beforeEach(() => {
        batches = [];
        query = jest.fn((sql: string): Promise<unknown> => {
            if (sql.includes("SET status = 'processing'")) {
                return Promise.resolve([batches.shift() ?? [], 0]);
            }
            return Promise.resolve([]);
        });
        notify = { subscribe: jest.fn<void, [NotifySubscription]>() };
        processor = {
            process: jest
                .fn<Promise<OrderEventOutcome>, [ClaimedOrderEvent]>()
                .mockResolvedValue({
                    status: 'processed',
                    customerId: 'c',
                    packageId: 'p',
                }),
        };
        worker = new OrderEventWorker(
            { query } as unknown as DataSource,
            notify as unknown as PgNotifyService,
            processor as unknown as OrderEventProcessor,
        );
    });

    afterEach(() => worker.onModuleDestroy());

    it('subscribes to the order event channel and drains on wake', async () => {
        worker.onApplicationBootstrap();

        const [subscription] = notify.subscribe.mock.calls[0];
        expect(subscription.channel).toBe(ORDER_EVENT_CHANNEL);

        batches.push([row('a')]);
        await subscription.onWake([]);
        expect(processor.process).toHaveBeenCalledWith(row('a'));
    });

    it('claims with SKIP LOCKED, reclaiming stale claims, and processes every row', async () => {
        batches.push([row('a'), row('b')]);

        await worker.drain();

        const [claimSql, claimParams] = query.mock.calls[0];
        expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
        expect(claimSql).toContain("status = 'processing'");
        expect(claimParams).toEqual([5, 10]);
        expect(processor.process).toHaveBeenCalledTimes(2);
    });

    it('keeps claiming while full batches come back', async () => {
        batches.push(
            ['1', '2', '3', '4', '5'].map((id) => row(id)),
            [row('6')],
        );

        await worker.drain();

        expect(processor.process).toHaveBeenCalledTimes(6);
    });

    it('logs a non-processed outcome without writing anything itself', async () => {
        processor.process.mockResolvedValue({
            status: 'needs_attention',
            error: 'No warehouse',
        });
        batches.push([row('a')]);

        await worker.drain();

        expect(failureWrites()).toHaveLength(0);
    });

    it('puts a transient failure back to pending with a backoff', async () => {
        processor.process.mockRejectedValue(new Error('Photon timed out'));
        batches.push([row('a', 2)]);

        await worker.drain();

        const [[, params]] = failureWrites();
        expect(params).toEqual(['a', 'pending', 'Photon timed out', 300]);
    });

    it('marks the row failed once the attempts run out', async () => {
        processor.process.mockRejectedValue('boom');
        batches.push([row('a', MAX_ATTEMPTS)]);

        await worker.drain();

        const [[, params]] = failureWrites();
        expect(params).toEqual(['a', 'failed', 'boom', 3600]);
    });

    it('survives a failure to record the failure', async () => {
        processor.process.mockRejectedValue(new Error('db down'));
        query.mockImplementation((sql: string): Promise<unknown> => {
            if (sql.includes("SET status = 'processing'")) {
                return Promise.resolve([batches.shift() ?? [], 0]);
            }
            return Promise.reject(new Error('still down'));
        });
        batches.push([row('a')]);

        await expect(worker.drain()).resolves.toBeUndefined();
    });

    it('survives a failed claim', async () => {
        query.mockRejectedValue(new Error('connection reset'));
        await expect(worker.drain()).resolves.toBeUndefined();
        expect(processor.process).not.toHaveBeenCalled();
    });

    it('is single-flight: a drain requested mid-drain runs once afterwards', async () => {
        let release!: () => void;
        processor.process.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () =>
                        resolve({
                            status: 'processed',
                            customerId: 'c',
                            packageId: 'p',
                        });
                }),
        );
        batches.push([row('a')]);

        const first = worker.drain();
        await new Promise((r) => setImmediate(r));
        const second = worker.drain();
        batches.push([row('b')]);
        release();
        await Promise.all([first, second]);

        expect(processor.process).toHaveBeenCalledTimes(2);
    });
});
