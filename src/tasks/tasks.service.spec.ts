import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { TasksService } from './tasks.service';
import { DatabaseService } from 'src/database/database.service';
import { VroomService } from 'src/vroom/vroom.service';
import { SchedulerRun } from 'src/entities/scheduler-run.entity';
import { QueueService } from './queue.service';

type MockRunner = {
    query: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
};

function makeRunner(queryImpl?: jest.Mock): MockRunner {
    return {
        query: queryImpl ?? jest.fn().mockResolvedValue([]),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
    };
}

const WAREHOUSE_ROWS = [{ id: 'wh-1', organisation_id: 'org-1', tzid: 'UTC' }];

describe('TasksService', () => {
    let service: TasksService;
    let dsQuery: jest.Mock;
    /** execute() of the scheduler_runs atomic-claim INSERT query builder. */
    let claimExecute: jest.Mock;
    /** execute() of the scheduler_runs retry_count UPDATE query builder. */
    let retryExecute: jest.Mock;
    let schedulerRunRepo: { update: jest.Mock; createQueryBuilder: jest.Mock };
    let dbService: {
        beginTransaction: jest.Mock;
        buildOptimizationRequest: jest.Mock;
        insertOptimisedRoutes: jest.Mock;
    };
    let vroomService: { solve: jest.Mock };
    let queueService: {
        ensureQueue: jest.Mock;
        enqueue: jest.Mock;
        readOne: jest.Mock;
        archive: jest.Mock;
        deleteMsg: jest.Mock;
    };

    beforeEach(async () => {
        dsQuery = jest.fn().mockResolvedValue(WAREHOUSE_ROWS);

        // DataSource.createQueryBuilder() — atomic scheduler_runs claim. Default:
        // claim loses (no identifiers) so time-of-day never triggers an enqueue.
        claimExecute = jest.fn().mockResolvedValue({ identifiers: [] });
        const claimQb = {
            insert: jest.fn().mockReturnThis(),
            into: jest.fn().mockReturnThis(),
            values: jest.fn().mockReturnThis(),
            orIgnore: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: claimExecute,
        };

        // SchedulerRun repository — retry_count UPDATE ... RETURNING builder.
        retryExecute = jest.fn().mockResolvedValue({ raw: [] });
        const retryQb = {
            update: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            returning: jest.fn().mockReturnThis(),
            execute: retryExecute,
        };
        schedulerRunRepo = {
            update: jest.fn().mockResolvedValue(undefined),
            createQueryBuilder: jest.fn().mockReturnValue(retryQb),
        };

        queueService = {
            ensureQueue: jest.fn().mockResolvedValue(undefined),
            enqueue: jest.fn().mockResolvedValue(undefined),
            readOne: jest.fn().mockResolvedValue(null),
            archive: jest.fn().mockResolvedValue(undefined),
            deleteMsg: jest.fn().mockResolvedValue(undefined),
        };
        dbService = {
            beginTransaction: jest.fn(),
            buildOptimizationRequest: jest.fn(),
            insertOptimisedRoutes: jest.fn().mockResolvedValue(undefined),
        };
        vroomService = { solve: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TasksService,
                {
                    provide: getDataSourceToken(),
                    useValue: { query: dsQuery, createQueryBuilder: jest.fn(() => claimQb) },
                },
                { provide: getRepositoryToken(SchedulerRun), useValue: schedulerRunRepo },
                { provide: DatabaseService, useValue: dbService },
                { provide: VroomService, useValue: vroomService },
                { provide: QueueService, useValue: queueService },
            ],
        }).compile();

        service = module.get<TasksService>(TasksService);
    });

    // ---------------------------------------------------------------------------
    // onApplicationBootstrap
    // ---------------------------------------------------------------------------
    describe('onApplicationBootstrap', () => {
        it('ensures queue and populates the warehouse cache', async () => {
            await service.onApplicationBootstrap();
            expect(queueService.ensureQueue).toHaveBeenCalled();
            expect(dsQuery).toHaveBeenCalledWith(
                expect.stringContaining('warehouse w'),
            );
        });
    });

    // ---------------------------------------------------------------------------
    // handleCron
    // ---------------------------------------------------------------------------
    describe('handleCron', () => {
        it('refreshes warehouse cache when TTL has expired (fresh start)', async () => {
            dsQuery.mockResolvedValue([]);
            await service.handleCron();
            expect(dsQuery).toHaveBeenCalledWith(
                expect.stringContaining('warehouse w'),
            );
        });

        it('does not re-fetch cache when it was recently built', async () => {
            // Populate the cache first — this sets cacheBuiltAt to now.
            await service.onApplicationBootstrap();
            const callCountAfterBoot = dsQuery.mock.calls.length;
            // handleCron within the same second — TTL (1hr) has not expired.
            await service.handleCron();
            // The warehouse refresh SQL should NOT be called again.
            const newCalls = dsQuery.mock.calls
                .slice(callCountAfterBoot)
                .filter((c: unknown[]) => String(c[0]).includes('warehouse w'));
            expect(newCalls).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------------------
    // handleQueue
    // ---------------------------------------------------------------------------
    describe('handleQueue', () => {
        it('returns immediately when the queue is empty', async () => {
            queueService.readOne.mockResolvedValueOnce(null);
            await service.handleQueue();
            expect(dbService.beginTransaction).not.toHaveBeenCalled();
        });

        it('rolls back and archives when runOptimization finds no jobs', async () => {
            queueService.readOne.mockResolvedValueOnce({
                msg_id: BigInt(1),
                read_ct: 0,
                enqueued_at: new Date(),
                vt: new Date(),
                message: { warehouseId: 'wh-1', runDate: '2026-05-09' },
            });
            const runner = makeRunner();
            dbService.beginTransaction.mockResolvedValueOnce(runner);
            dbService.buildOptimizationRequest.mockResolvedValueOnce({
                request: { jobs: [], vehicles: [] },
                vehicleMap: {},
                jobMap: {},
                driverMap: {},
            });

            await service.handleQueue();

            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(vroomService.solve).not.toHaveBeenCalled();
            expect(queueService.archive).toHaveBeenCalledWith(BigInt(1));
        });

        it('commits and archives when optimization succeeds with jobs', async () => {
            queueService.readOne.mockResolvedValueOnce({
                msg_id: BigInt(2),
                read_ct: 0,
                enqueued_at: new Date(),
                vt: new Date(),
                message: { warehouseId: 'wh-1', runDate: '2026-05-09' },
            });
            const runner = makeRunner();
            dbService.beginTransaction.mockResolvedValueOnce(runner);
            const request = {
                jobs: [{ id: 1, service: 900, location: [151.2, -33.8], amount: [2000], priority: 50 }],
                vehicles: [
                    {
                        id: 1,
                        profile: 'auto',
                        start: [151.0, -33.7],
                        end: [151.0, -33.7],
                        capacity: [5000],
                    },
                ],
            };
            dbService.buildOptimizationRequest.mockResolvedValueOnce({
                request,
                vehicleMap: { 1: 'veh-1' },
                jobMap: { 1: 'pkg-1' },
                driverMap: { 1: 'drv-1' },
            });
            vroomService.solve.mockResolvedValueOnce({
                code: 0,
                summary: { cost: 100, routes: 1, unassigned: 0 },
                routes: [
                    {
                        vehicle: 1,
                        cost: 100,
                        delivery: [0],
                        pickup: [0],
                        service: 0,
                        duration: 3600,
                        waiting_time: 0,
                        steps: [],
                    },
                ],
                unassigned: [],
            });

            await service.handleQueue();

            expect(vroomService.solve).toHaveBeenCalledTimes(1);
            expect(vroomService.solve).toHaveBeenCalledWith(request);
            expect(runner.commitTransaction).toHaveBeenCalled();
            expect(queueService.archive).toHaveBeenCalledWith(BigInt(2));
            expect(schedulerRunRepo.update).toHaveBeenCalledWith(
                { warehouseId: 'wh-1', runDate: '2026-05-09' },
                { status: 'completed' },
            );
        });

        it('increments retry count and does NOT delete before MAX_RETRIES', async () => {
            queueService.readOne.mockResolvedValueOnce({
                msg_id: BigInt(3),
                read_ct: 0,
                enqueued_at: new Date(),
                vt: new Date(),
                message: { warehouseId: 'wh-1', runDate: '2026-05-09' },
            });
            dbService.beginTransaction.mockRejectedValueOnce(new Error('DB connection lost'));
            // UPDATE scheduler_runs SET retry_count = retry_count + 1 → below MAX_RETRIES
            retryExecute.mockResolvedValueOnce({ raw: [{ retry_count: 1 }] });

            await service.handleQueue();

            expect(queueService.deleteMsg).not.toHaveBeenCalled();
            expect(queueService.archive).not.toHaveBeenCalled();
        });

        it('deletes message and marks run failed when MAX_RETRIES is reached', async () => {
            queueService.readOne.mockResolvedValueOnce({
                msg_id: BigInt(4),
                read_ct: 2,
                enqueued_at: new Date(),
                vt: new Date(),
                message: { warehouseId: 'wh-1', runDate: '2026-05-09' },
            });
            dbService.beginTransaction.mockRejectedValueOnce(new Error('Persistent failure'));
            // retry_count has reached MAX_RETRIES (3)
            retryExecute.mockResolvedValueOnce({ raw: [{ retry_count: 3 }] });

            await service.handleQueue();

            expect(queueService.deleteMsg).toHaveBeenCalledWith(BigInt(4));
            expect(schedulerRunRepo.update).toHaveBeenCalledWith(
                { warehouseId: 'wh-1', runDate: '2026-05-09' },
                { status: 'failed' },
            );
        });

        it('falls back to MAX_RETRIES when scheduler_runs UPDATE returns no rows', async () => {
            queueService.readOne.mockResolvedValueOnce({
                msg_id: BigInt(5),
                read_ct: 0,
                enqueued_at: new Date(),
                vt: new Date(),
                message: { warehouseId: 'wh-1', runDate: '2026-05-09' },
            });
            dbService.beginTransaction.mockRejectedValueOnce(new Error('Connection lost'));
            // UPDATE returned no rows — raw[0] is undefined, falls back to MAX_RETRIES
            retryExecute.mockResolvedValueOnce({ raw: [] });

            await service.handleQueue();

            // MAX_RETRIES fallback means permanent failure path is taken
            expect(queueService.deleteMsg).toHaveBeenCalledWith(BigInt(5));
        });
    });
});
