import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { QueueService } from './queue.service';

describe('QueueService', () => {
    let service: QueueService;
    let dsQuery: jest.Mock;

    beforeEach(async () => {
        dsQuery = jest.fn().mockResolvedValue([]);
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                QueueService,
                {
                    provide: getDataSourceToken(),
                    useValue: { query: dsQuery },
                },
            ],
        }).compile();
        service = module.get<QueueService>(QueueService);
    });

    describe('ensureQueue', () => {
        it('calls pgmq.create when the queue does not exist', async () => {
            dsQuery.mockResolvedValueOnce([]); // list_queues() -> absent
            await service.ensureQueue();
            expect(dsQuery).toHaveBeenCalledWith(
                expect.stringContaining('pgmq.create'),
                expect.any(Array),
            );
        });

        it('does not call pgmq.create when the queue already exists', async () => {
            dsQuery.mockResolvedValueOnce([{ queue_name: 'warehouse-optimization' }]);
            await service.ensureQueue();
            const calledCreate = dsQuery.mock.calls.some(
                ([sql]) => typeof sql === 'string' && sql.includes('pgmq.create'),
            );
            expect(calledCreate).toBe(false);
        });
    });

    it('enqueue calls pgmq.send with the serialised message', async () => {
        await service.enqueue('wh-1', '2026-05-09');
        const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('pgmq.send');
        expect(params[0]).toBe('warehouse-optimization');
        const msg = JSON.parse(params[1] as string);
        expect(msg.warehouseId).toBe('wh-1');
        expect(msg.runDate).toBe('2026-05-09');
    });

    describe('readOne', () => {
        it('returns null when the queue is empty', async () => {
            dsQuery.mockResolvedValueOnce([]);
            const result = await service.readOne(30);
            expect(result).toBeNull();
        });

        it('returns the first message when one exists', async () => {
            const msg = {
                msg_id: BigInt(1),
                read_ct: 0,
                enqueued_at: new Date(),
                vt: new Date(),
                message: { warehouseId: 'wh-1', runDate: '2026-05-09' },
            };
            dsQuery.mockResolvedValueOnce([msg]);
            const result = await service.readOne(30);
            expect(result).toBe(msg);
        });
    });

    it('archive calls pgmq.archive with the correct message id', async () => {
        await service.archive(BigInt(5));
        const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('pgmq.archive');
        expect(params).toContain(BigInt(5));
    });

    it('deleteMsg calls pgmq.delete with the correct message id', async () => {
        await service.deleteMsg(BigInt(7));
        const [sql, params] = dsQuery.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('pgmq.delete');
        expect(params).toContain(BigInt(7));
    });
});
