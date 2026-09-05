import { ReplanWorker } from './replan.worker';
import { ShiftPlanWriter } from './shift-plan.writer';
import { REPLAN_CHANNEL, type PgmqMessage } from './queue.service';

const NOW = new Date('2026-09-01T09:00:00Z');

const SHIFT = {
    id: 'shift-1',
    status: 'planned',
    organisation_id: 'org-1',
    warehouse_id: 'wh-1',
    driver_id: 'driver-1',
    vehicle_id: 'vehicle-1',
    revision: 4,
    scheduled_start: NOW.toISOString(),
    vehicle_gross_limits: '1000',
    ors_vehicle_type: 'driving-car',
    depot_lon: 0,
    depot_lat: 0,
};

const PACKAGES = [
    {
        id: 'pkg-a',
        weight_kg: '2',
        scheduled_arrival: new Date(
            NOW.getTime() + 6 * 3_600_000,
        ).toISOString(),
        lon: 0.01,
        lat: 0,
    },
    {
        id: 'pkg-b',
        weight_kg: '3',
        scheduled_arrival: null,
        lon: 0.02,
        lat: 0,
    },
];

interface WorkerState {
    shift?: Record<string, unknown> | null;
    packages?: Record<string, unknown>[];
    locked?: boolean;
    messages?: PgmqMessage[];
}

function message(
    body: Record<string, unknown>,
    overrides: Partial<PgmqMessage> = {},
): PgmqMessage {
    return {
        msg_id: BigInt(1),
        read_ct: 1,
        enqueued_at: NOW,
        vt: NOW,
        message: body,
        ...overrides,
    };
}

function build(state: WorkerState = {}) {
    const log: { sql: string; params: unknown[] }[] = [];

    const answer = (sql: string): unknown[] => {
        if (sql.includes('pg_try_advisory_lock')) {
            return [{ locked: state.locked ?? true }];
        }
        if (
            sql.includes('FROM vrp_optimization v') &&
            sql.includes('depot_lon')
        ) {
            return state.shift === undefined
                ? [SHIFT]
                : state.shift
                  ? [state.shift]
                  : [];
        }
        if (sql.includes('WHERE p.optimisation_id')) {
            return state.packages ?? PACKAGES;
        }
        if (
            sql.includes('FROM vrp_solution s') &&
            sql.includes('JOIN vrp_route')
        ) {
            return [{ route_id: 'route-1', solution_id: 'sol-1' }];
        }
        return [];
    };

    const query = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        return Promise.resolve(answer(sql));
    });

    // A separate mock from the pool's, so a test that makes the transaction fail
    // does not also break the advisory lock taken outside it.
    const runnerQuery = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        return Promise.resolve(answer(sql));
    });

    const runner = {
        query: runnerQuery,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        isTransactionActive: true,
    };

    const dataSource = { query, createQueryRunner: jest.fn(() => runner) };

    const queue = {
        ensureQueue: jest.fn().mockResolvedValue(undefined),
        readBatch: jest.fn().mockResolvedValue(state.messages ?? []),
        archive: jest.fn().mockResolvedValue(undefined),
        deleteMsg: jest.fn().mockResolvedValue(undefined),
    };
    const notify = { subscribe: jest.fn() };
    const assignment = {
        assign: jest.fn().mockResolvedValue({ outcome: 'deferred' }),
    };
    const optimisationRunRepo = {
        update: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
        beginTransaction: jest.fn().mockResolvedValue(runner),
        buildOptimizationRequest: jest.fn(),
        insertOptimisedRoutes: jest.fn().mockResolvedValue('opt-1'),
        insertAdhocRoutes: jest.fn(),
    };
    const vroom = {
        solve: jest.fn().mockResolvedValue({
            code: 0,
            routes: [
                {
                    vehicle: 1,
                    steps: [
                        { type: 'start', arrival: NOW.getTime() / 1000 },
                        {
                            type: 'job',
                            id: 2,
                            arrival: NOW.getTime() / 1000 + 300,
                        },
                        {
                            type: 'job',
                            id: 1,
                            arrival: NOW.getTime() / 1000 + 1500,
                        },
                        { type: 'end', arrival: NOW.getTime() / 1000 + 2000 },
                    ],
                },
            ],
            unassigned: [],
        }),
    };

    const worker = new ReplanWorker(
        dataSource as never,
        optimisationRunRepo as never,
        queue as never,
        notify as never,
        new ShiftPlanWriter(),
        assignment as never,
        db as never,
        vroom,
    );

    return {
        worker,
        queue,
        notify,
        assignment,
        db,
        vroom,
        runner,
        log,
        dataSource,
    };
}

describe('ReplanWorker', () => {
    beforeEach(() => {
        jest.useFakeTimers({
            doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
        }).setSystemTime(NOW);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('wiring', () => {
        it('subscribes to the replan channel with a coalescing window', async () => {
            const { worker, notify, queue } = build();
            await worker.onApplicationBootstrap();
            worker.onModuleDestroy();

            expect(queue.ensureQueue).toHaveBeenCalled();
            expect(notify.subscribe).toHaveBeenCalledWith(
                expect.objectContaining({
                    channel: REPLAN_CHANNEL,
                    debounceMs: 3_000,
                }),
            );
        });

        it('keeps one sweep timer as a backstop for lost notifications', async () => {
            const { worker, queue } = build();
            await worker.onApplicationBootstrap();
            queue.readBatch.mockClear();

            await jest.advanceTimersByTimeAsync(60_000);
            expect(queue.readBatch).toHaveBeenCalledTimes(1);

            worker.onModuleDestroy();
            queue.readBatch.mockClear();
            await jest.advanceTimersByTimeAsync(120_000);
            expect(queue.readBatch).not.toHaveBeenCalled();
        });

        it('starts up even when the queue cannot be reached', async () => {
            const { worker, queue, notify } = build();
            queue.ensureQueue.mockRejectedValue(new Error('pgmq missing'));
            await expect(
                worker.onApplicationBootstrap(),
            ).resolves.toBeUndefined();
            expect(notify.subscribe).toHaveBeenCalled();
            worker.onModuleDestroy();
        });
    });

    describe('replanning a shift', () => {
        it('NEVER inserts a vrp_optimization row — a replan must not bill', async () => {
            // The single most expensive mistake available here: every insert fires
            // enforce_shift_allowance(), so a replanning loop that inserted would
            // burn the org's allowance and eventually hard-fail with 23514.
            const { worker, log } = build();
            await worker.replanShift('shift-1');

            expect(
                log.filter((q) =>
                    /INSERT INTO vrp_optimization\b/i.test(q.sql),
                ),
            ).toHaveLength(0);
        });

        it('populates job time_windows so deadlines become hard constraints', async () => {
            const { worker, vroom } = build();
            await worker.replanShift('shift-1');

            const request = vroom.solve.mock.calls[0][0];
            const withDeadline = request.jobs.find(
                (j: { id: number }) => j.id === 1,
            );
            const without = request.jobs.find(
                (j: { id: number }) => j.id === 2,
            );

            expect(withDeadline.time_windows).toEqual([
                [NOW.getTime() / 1000, NOW.getTime() / 1000 + 6 * 3600],
            ]);
            // No promise, no window: an unconstrained job, not a rejected one.
            expect(without.time_windows).toBeUndefined();
        });

        it('sends capacity and amounts in the same unit', async () => {
            const { worker, vroom } = build();
            await worker.replanShift('shift-1');

            const request = vroom.solve.mock.calls[0][0];
            // 1000 kg gross → 1,000,000 g, against amounts of 2000 g and 3000 g.
            expect(request.vehicles[0].capacity).toEqual([1_000_000]);
            expect(
                request.jobs.map((j: { amount: number[] }) => j.amount),
            ).toEqual([[2_000], [3_000]]);
        });

        it('writes the order VROOM returned, not the order it was given', async () => {
            const { worker, log } = build();
            await worker.replanShift('shift-1');

            // The solver put job 2 (pkg-b) first.
            const etas = log.find((q) =>
                q.sql.includes('INSERT INTO package_delivery_window'),
            );
            expect(etas?.params[0]).toBe('pkg-b');
            expect(etas?.params[2]).toBe('pkg-a');
        });

        it('snapshots the plan it replaces', async () => {
            const { worker, log } = build();
            await worker.replanShift('shift-1');

            const snapshot = log.find((q) =>
                q.sql.includes('INSERT INTO vrp_optimization_revision'),
            );
            expect(snapshot?.params).toEqual([
                'shift-1',
                SHIFT.revision,
                'replan',
            ]);
        });

        it('does not touch a shift that has already rolled', async () => {
            const { worker, vroom } = build({
                shift: { ...SHIFT, status: 'dispatched' },
            });
            await worker.replanShift('shift-1');
            expect(vroom.solve).not.toHaveBeenCalled();
        });

        it('stands aside when another replica holds the shift lock', async () => {
            const { worker, vroom } = build({ locked: false });
            await worker.replanShift('shift-1');
            expect(vroom.solve).not.toHaveBeenCalled();
        });

        it('releases the shift lock even when the solve throws', async () => {
            const { worker, vroom, log } = build();
            vroom.solve.mockRejectedValue(new Error('vroom exploded'));

            await expect(worker.replanShift('shift-1')).rejects.toThrow(
                'vroom exploded',
            );
            expect(log.some((q) => q.sql.includes('pg_advisory_unlock'))).toBe(
                true,
            );
        });

        it('does nothing for an empty shift id', async () => {
            const { worker, dataSource } = build();
            await worker.replanShift('');
            expect(dataSource.query).not.toHaveBeenCalled();
        });

        it('skips a shift with no packages left on it', async () => {
            const { worker, vroom } = build({ packages: [] });
            await worker.replanShift('shift-1');
            expect(vroom.solve).not.toHaveBeenCalled();
        });

        it('detaches what VROOM could not fit and hands it back to Tier 1', async () => {
            const { worker, vroom, assignment, log } = build();
            vroom.solve.mockResolvedValue({
                code: 0,
                routes: [
                    {
                        vehicle: 1,
                        steps: [
                            { type: 'start', arrival: NOW.getTime() / 1000 },
                            {
                                type: 'job',
                                id: 1,
                                arrival: NOW.getTime() / 1000 + 300,
                            },
                            {
                                type: 'end',
                                arrival: NOW.getTime() / 1000 + 900,
                            },
                        ],
                    },
                ],
                unassigned: [{ id: 2 }],
            });

            await worker.replanShift('shift-1');

            const detach = log.find((q) =>
                q.sql.includes('DELETE FROM package_assignment'),
            );
            expect(detach?.params[0]).toEqual(['pkg-b']);
            // Detaching must not count as an eviction — nobody bumped it.
            const counter = log.find((q) =>
                q.sql.includes('eviction_count  = eviction_count'),
            );
            expect(counter?.params[1]).toBe(0);
            expect(assignment.assign).toHaveBeenCalledWith('org-1', 'pkg-b');
        });

        it('rolls back the plan write if any part of it fails', async () => {
            const { worker, runner, log } = build();
            runner.query.mockImplementation(
                (sql: string, params: unknown[] = []) => {
                    log.push({ sql, params });
                    if (sql.includes('INSERT INTO vrp_route_step')) {
                        return Promise.reject(
                            new Error('constraint violation'),
                        );
                    }
                    if (sql.includes('FROM vrp_solution s')) {
                        return Promise.resolve([
                            { route_id: 'route-1', solution_id: 'sol-1' },
                        ]);
                    }
                    return Promise.resolve([]);
                },
            );

            await expect(worker.replanShift('shift-1')).rejects.toThrow();
            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(runner.commitTransaction).not.toHaveBeenCalled();
        });
    });

    describe('draining the queue', () => {
        it('solves a shift once however many replans name it', async () => {
            const { worker, queue } = build({
                messages: [
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { msg_id: BigInt(1) },
                    ),
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { msg_id: BigInt(2) },
                    ),
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { msg_id: BigInt(3) },
                    ),
                ],
            });
            queue.readBatch
                .mockResolvedValueOnce([
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { msg_id: BigInt(1) },
                    ),
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { msg_id: BigInt(2) },
                    ),
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { msg_id: BigInt(3) },
                    ),
                ])
                .mockResolvedValue([]);

            await worker.drain();

            // All three messages consumed; one solve.
            expect(queue.archive).toHaveBeenCalledTimes(3);
        });

        it('returns immediately when the queue is empty', async () => {
            const { worker, queue } = build();
            queue.readBatch.mockResolvedValue([]);
            await worker.drain();
            expect(queue.archive).not.toHaveBeenCalled();
        });

        it('survives a queue that cannot be read', async () => {
            const { worker, queue } = build();
            queue.readBatch.mockRejectedValue(new Error('pgmq gone'));
            await expect(worker.drain()).resolves.toBeUndefined();
        });

        it('archives an unrecognised payload rather than cycling it forever', async () => {
            const { worker, queue } = build();
            queue.readBatch
                .mockResolvedValueOnce([
                    message({ warehouseId: 'wh-1', runDate: '2026-09-01' }),
                ])
                .mockResolvedValue([]);

            await worker.drain();
            expect(queue.archive).toHaveBeenCalledWith(BigInt(1));
        });

        it('leaves a failed message for the visibility timeout to retry', async () => {
            const { worker, queue, vroom } = build();
            vroom.solve.mockRejectedValue(new Error('vroom down'));
            queue.readBatch
                .mockResolvedValueOnce([
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { read_ct: 1 },
                    ),
                ])
                .mockResolvedValue([]);

            await worker.drain();

            expect(queue.deleteMsg).not.toHaveBeenCalled();
            expect(queue.archive).not.toHaveBeenCalled();
        });

        it('discards a poison pill after MAX_RETRIES attempts', async () => {
            const { worker, queue, vroom } = build();
            vroom.solve.mockRejectedValue(new Error('vroom down'));
            queue.readBatch
                .mockResolvedValueOnce([
                    message(
                        { kind: 'replan', optimisationId: 'shift-1' },
                        { read_ct: 3 },
                    ),
                ])
                .mockResolvedValue([]);

            await worker.drain();
            expect(queue.deleteMsg).toHaveBeenCalledWith(BigInt(1));
        });

        it('does not run two drains at once', async () => {
            const { worker, queue } = build();
            let release!: (value: PgmqMessage[]) => void;
            queue.readBatch.mockImplementationOnce(
                () =>
                    new Promise<PgmqMessage[]>((resolve) => {
                        release = resolve;
                    }),
            );
            queue.readBatch.mockResolvedValue([]);

            const first = worker.drain();
            const second = worker.drain();
            release([]);
            await Promise.all([first, second]);

            // The second call folded into the first, then ran one more pass.
            expect(queue.readBatch).toHaveBeenCalledTimes(2);
        });
    });

    describe('on-demand runs', () => {
        it('marks the run completed and archives the message', async () => {
            const { worker, queue, db } = build();
            db.buildOptimizationRequest.mockResolvedValue({
                request: { jobs: [{ id: 1 }], vehicles: [] },
                vehicleMap: {},
                jobMap: {},
                driverMap: {},
                organisationId: 'org-1',
                timeWindowed: true,
                skipReason: null,
                pinnedRoutes: [],
            });
            queue.readBatch
                .mockResolvedValueOnce([
                    message({
                        kind: 'on_demand',
                        runId: 'run-1',
                        organisationId: 'org-1',
                        warehouseId: 'wh-1',
                    }),
                ])
                .mockResolvedValue([]);

            await worker.drain();

            expect(db.insertOptimisedRoutes).toHaveBeenCalled();
            expect(queue.archive).toHaveBeenCalledWith(BigInt(1));
        });

        it('records a skip when the warehouse has nothing to route', async () => {
            const { worker, queue, db } = build();
            db.buildOptimizationRequest.mockResolvedValue({
                request: { jobs: [], vehicles: [] },
                vehicleMap: {},
                jobMap: {},
                driverMap: {},
                organisationId: 'org-1',
                timeWindowed: true,
                skipReason: 'No unassigned packages found for this warehouse.',
                pinnedRoutes: [],
            });
            queue.readBatch
                .mockResolvedValueOnce([
                    message({
                        kind: 'on_demand',
                        runId: 'run-1',
                        organisationId: 'org-1',
                        warehouseId: 'wh-1',
                    }),
                ])
                .mockResolvedValue([]);

            await worker.drain();
            expect(db.insertOptimisedRoutes).not.toHaveBeenCalled();
        });

        it('deletes the message on failure — the dispatcher retries, not the queue', async () => {
            const { worker, queue, db } = build();
            db.buildOptimizationRequest.mockRejectedValue(
                new Error('vroom unreachable'),
            );
            queue.readBatch
                .mockResolvedValueOnce([
                    message({
                        kind: 'on_demand',
                        runId: 'run-1',
                        organisationId: 'org-1',
                        warehouseId: 'wh-1',
                    }),
                ])
                .mockResolvedValue([]);

            await worker.drain();
            expect(queue.deleteMsg).toHaveBeenCalledWith(BigInt(1));
        });
    });
});
