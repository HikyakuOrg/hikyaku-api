import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { DatabaseService } from './database.service';
import { Package } from 'src/entities/package.entity';
import { PackageAssignment } from 'src/entities/package-assignment.entity';
import { PackageStatus } from 'src/entities/package-status.entity';
import { VrpOptimization } from 'src/entities/vrp-optimization.entity';
import { VrpRoute } from 'src/entities/vrp-route.entity';
import { VrpSolution } from 'src/entities/vrp-solution.entity';

type MockManager = {
    insert: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
};

type MockRunner = {
    query: jest.Mock;
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: MockManager;
};

function makeRunner(queryImpl?: jest.Mock): MockRunner {
    return {
        query: queryImpl ?? jest.fn().mockResolvedValue([]),
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
            insert: jest.fn(),
            upsert: jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
        },
    };
}

/** Chains manager.insert results — one `{identifiers:[{id}]}` per expected insert. */
function chainInsertIds(runner: MockRunner, ...ids: string[]): void {
    for (const id of ids) {
        runner.manager.insert.mockResolvedValueOnce({ identifiers: [{ id }] });
    }
}

const ASSIGNMENT_ROW = {
    driver_id: 'drv-1',
    vehicle_id: 'veh-1',
    vehicle_gross_limits: 5000,
    ors_vehicle_type: 'driving-car',
    warehouse_lon: 151.2,
    warehouse_lat: -33.8,
};

describe('DatabaseService', () => {
    let service: DatabaseService;
    let dsQuery: jest.Mock;
    let dsCreateQueryRunner: jest.Mock;
    let findOneBy: jest.Mock;

    beforeEach(async () => {
        dsQuery = jest.fn().mockResolvedValue([]);
        const runner = makeRunner();
        dsCreateQueryRunner = jest.fn().mockReturnValue(runner);
        findOneBy = jest.fn().mockResolvedValue({ id: 1 });

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DatabaseService,
                {
                    provide: getDataSourceToken(),
                    useValue: { query: dsQuery, createQueryRunner: dsCreateQueryRunner },
                },
                { provide: getRepositoryToken(PackageStatus), useValue: { findOneBy } },
                // The remaining repositories are injected but never called directly —
                // all writes go through runner.manager.
                { provide: getRepositoryToken(Package), useValue: {} },
                { provide: getRepositoryToken(PackageAssignment), useValue: {} },
                { provide: getRepositoryToken(VrpOptimization), useValue: {} },
                { provide: getRepositoryToken(VrpSolution), useValue: {} },
                { provide: getRepositoryToken(VrpRoute), useValue: {} },
            ],
        }).compile();

        service = module.get<DatabaseService>(DatabaseService);
    });

    // ---------------------------------------------------------------------------
    // onApplicationBootstrap
    // ---------------------------------------------------------------------------
    describe('onApplicationBootstrap', () => {
        it('resolves when the PENDING status row exists', async () => {
            findOneBy.mockResolvedValueOnce({ id: 7 });
            await expect(service.onApplicationBootstrap()).resolves.not.toThrow();
            expect(findOneBy).toHaveBeenCalledWith({ enums: 'PENDING' });
        });

        it('throws an Error when no PENDING status row is found', async () => {
            findOneBy.mockResolvedValueOnce(null);
            await expect(service.onApplicationBootstrap()).rejects.toThrow(
                "package_status row with enums = 'PENDING' not found.",
            );
        });
    });

    // ---------------------------------------------------------------------------
    // query
    // ---------------------------------------------------------------------------
    describe('query', () => {
        it('delegates to the underlying DataSource and returns rows', async () => {
            const rows = [{ id: 'r1' }, { id: 'r2' }];
            dsQuery.mockResolvedValueOnce(rows);
            const result = await service.query<{ id: string }>('SELECT 1', []);
            expect(result).toEqual(rows);
        });
    });

    // ---------------------------------------------------------------------------
    // beginTransaction
    // ---------------------------------------------------------------------------
    describe('beginTransaction', () => {
        it('connects the runner and starts a transaction', async () => {
            const runner = makeRunner();
            dsCreateQueryRunner.mockReturnValueOnce(runner);

            const result = await service.beginTransaction();

            expect(runner.connect).toHaveBeenCalled();
            expect(runner.startTransaction).toHaveBeenCalled();
            expect(result).toBe(runner);
        });
    });

    // ---------------------------------------------------------------------------
    // buildOptimizationRequest
    // ---------------------------------------------------------------------------
    describe('buildOptimizationRequest', () => {
        beforeEach(async () => {
            // Ensure pendingStatusId is set before these tests run.
            await service.onApplicationBootstrap();
        });

        it('throws when warehouse location cannot be determined', async () => {
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([]) // no packages
                    .mockResolvedValueOnce([]), // no assignments
            );
            await expect(
                service.buildOptimizationRequest(runner as never),
            ).rejects.toThrow('Could not determine warehouse location');
        });

        it('returns a BuildResult with jobs and vehicles', async () => {
            const today = new Date();
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([
                        {
                            id: 'pkg-1',
                            tracking_number: 'TRK001',
                            created_at: today,
                            warehouse_id: 'wh-1',
                            warehouse_lon: 151.2,
                            warehouse_lat: -33.8,
                            weight_kg: 2,
                            scheduled_arrival: today.toISOString(),
                            customer_lon: 151.3,
                            customer_lat: -33.9,
                        },
                    ])
                    .mockResolvedValueOnce([ASSIGNMENT_ROW])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.request.jobs).toHaveLength(1);
            expect(result.request.vehicles).toHaveLength(1);
            expect(result.jobMap[1]).toBe('pkg-1');
            expect(result.vehicleMap[1]).toBe('veh-1');
        });

        it('maps ors_vehicle_type to a Valhalla costing profile', async () => {
            const today = new Date();
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([
                        {
                            id: 'pkg-1',
                            tracking_number: 'TRK001',
                            created_at: today,
                            warehouse_id: 'wh-1',
                            warehouse_lon: 151.2,
                            warehouse_lat: -33.8,
                            weight_kg: 2,
                            scheduled_arrival: today.toISOString(),
                            customer_lon: 151.3,
                            customer_lat: -33.9,
                        },
                    ])
                    .mockResolvedValueOnce([
                        ASSIGNMENT_ROW, // driving-car
                        { ...ASSIGNMENT_ROW, vehicle_id: 'veh-2', ors_vehicle_type: 'driving-hgv' },
                    ])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.request.vehicles[0].profile).toBe('auto');
            expect(result.request.vehicles[1].profile).toBe('truck');
        });

        it('assigns priority 100 to past-due packages', async () => {
            const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([
                        {
                            id: 'pkg-past',
                            tracking_number: 'TRK002',
                            created_at: new Date(),
                            warehouse_id: 'wh-1',
                            warehouse_lon: 151.2,
                            warehouse_lat: -33.8,
                            weight_kg: 1,
                            scheduled_arrival: pastDue.toISOString(),
                            customer_lon: 151.3,
                            customer_lat: -33.9,
                        },
                    ])
                    .mockResolvedValueOnce([ASSIGNMENT_ROW])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.request.jobs[0].priority).toBe(100);
        });

        it('skips packages with a future scheduled_arrival', async () => {
            const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([
                        {
                            id: 'pkg-future',
                            tracking_number: 'TRK003',
                            created_at: new Date(),
                            warehouse_id: 'wh-1',
                            warehouse_lon: 151.2,
                            warehouse_lat: -33.8,
                            weight_kg: 1,
                            scheduled_arrival: future.toISOString(),
                            customer_lon: 151.3,
                            customer_lat: -33.9,
                        },
                    ])
                    .mockResolvedValueOnce([ASSIGNMENT_ROW])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.request.jobs).toHaveLength(0);
            expect(result.skipReason).toBe(
                '1 candidate package(s) found but all were excluded (1 scheduled for a future date).',
            );
        });

        it('skips packages whose customer has no geocoded location', async () => {
            const today = new Date();
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([
                        {
                            id: 'pkg-no-geo',
                            tracking_number: 'TRK005',
                            created_at: today,
                            warehouse_id: 'wh-1',
                            warehouse_lon: 151.2,
                            warehouse_lat: -33.8,
                            weight_kg: 1,
                            scheduled_arrival: today.toISOString(),
                            customer_lon: null,
                            customer_lat: null,
                        },
                    ])
                    .mockResolvedValueOnce([ASSIGNMENT_ROW])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.request.jobs).toHaveLength(0);
            expect(result.skipReason).toBe(
                '1 candidate package(s) found but all were excluded (1 missing a geocoded customer location).',
            );
        });

        it('explains an empty candidate set via the already-assigned/not-pending diagnostic query', async () => {
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([]) // no PENDING/unassigned packages
                    .mockResolvedValueOnce([ASSIGNMENT_ROW]) // assignment supplies warehouse coords
                    .mockResolvedValueOnce([{ already_assigned: '2', not_pending: '1' }]) // diagnostic query
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.request.jobs).toHaveLength(0);
            expect(result.skipReason).toBe(
                'No eligible packages: 1 not in PENDING status, 2 already have a driver/vehicle assignment.',
            );
        });

        it('reports a plain "no packages" reason when the diagnostic query also finds nothing', async () => {
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([]) // no PENDING/unassigned packages
                    .mockResolvedValueOnce([ASSIGNMENT_ROW])
                    .mockResolvedValueOnce([{ already_assigned: '0', not_pending: '0' }])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            expect(result.skipReason).toBe('No unassigned packages found for this warehouse.');
        });

        it('falls back to vehicle warehouse coords when packages have none', async () => {
            const today = new Date();
            const runner = makeRunner(
                jest.fn()
                    .mockResolvedValueOnce([
                        {
                            id: 'pkg-no-wh',
                            tracking_number: 'TRK004',
                            created_at: today,
                            warehouse_id: 'wh-1',
                            warehouse_lon: null,
                            warehouse_lat: null,
                            weight_kg: 1,
                            scheduled_arrival: today.toISOString(),
                            customer_lon: 151.3,
                            customer_lat: -33.9,
                        },
                    ])
                    .mockResolvedValueOnce([ASSIGNMENT_ROW])
                    .mockResolvedValueOnce([]), // no pinned (already-assigned) packages
            );

            const result = await service.buildOptimizationRequest(runner as never);

            // Vehicle warehouse coords used — start/end should be set
            expect(result.request.vehicles[0].start).toEqual([151.2, -33.8]);
        });

        describe('pinned routes (packages already paired outside the optimiser)', () => {
            const TODAY = new Date();
            const NORMAL_PACKAGE = {
                id: 'pkg-1',
                tracking_number: 'TRK001',
                created_at: TODAY,
                warehouse_id: 'wh-1',
                warehouse_lon: 151.2,
                warehouse_lat: -33.8,
                weight_kg: 2,
                scheduled_arrival: TODAY.toISOString(),
                customer_lon: 151.3,
                customer_lat: -33.9,
            };
            const PINNED_ROW = {
                id: 'pkg-pinned-1',
                driver_id: 'drv-9',
                vehicle_id: 'veh-9',
                vehicle_gross_limits: 3000,
                ors_vehicle_type: 'driving-hgv',
                weight_kg: 2,
                scheduled_arrival: TODAY.toISOString(),
                customer_lon: 151.4,
                customer_lat: -34.0,
            };

            it('builds a single-vehicle pinned route alongside the main request', async () => {
                const runner = makeRunner(
                    jest.fn()
                        .mockResolvedValueOnce([NORMAL_PACKAGE])
                        .mockResolvedValueOnce([ASSIGNMENT_ROW])
                        .mockResolvedValueOnce([PINNED_ROW]),
                );

                const result = await service.buildOptimizationRequest(runner as never);

                expect(result.request.jobs).toHaveLength(1); // main solve unaffected
                expect(result.pinnedRoutes).toHaveLength(1);
                const pinned = result.pinnedRoutes[0];
                expect(pinned.driverId).toBe('drv-9');
                expect(pinned.vehicleId).toBe('veh-9');
                expect(pinned.jobPackageMap[1]).toBe('pkg-pinned-1');
                expect(pinned.request.jobs).toHaveLength(1);
                expect(pinned.request.jobs[0].location).toEqual([151.4, -34.0]);
                expect(pinned.request.vehicles).toHaveLength(1);
                expect(pinned.request.vehicles[0].profile).toBe('truck');
                expect(pinned.scheduledStart).toBeInstanceOf(Date);
            });

            it('groups multiple pinned packages sharing a driver/vehicle pair into one route', async () => {
                const runner = makeRunner(
                    jest.fn()
                        .mockResolvedValueOnce([NORMAL_PACKAGE])
                        .mockResolvedValueOnce([ASSIGNMENT_ROW])
                        .mockResolvedValueOnce([
                            PINNED_ROW,
                            { ...PINNED_ROW, id: 'pkg-pinned-2', customer_lon: 151.5, customer_lat: -34.1 },
                        ]),
                );

                const result = await service.buildOptimizationRequest(runner as never);

                expect(result.pinnedRoutes).toHaveLength(1);
                expect(result.pinnedRoutes[0].request.jobs).toHaveLength(2);
                expect(Object.values(result.pinnedRoutes[0].jobPackageMap).sort()).toEqual([
                    'pkg-pinned-1',
                    'pkg-pinned-2',
                ]);
            });

            it('keeps separately-paired vehicles as separate routes', async () => {
                const runner = makeRunner(
                    jest.fn()
                        .mockResolvedValueOnce([NORMAL_PACKAGE])
                        .mockResolvedValueOnce([ASSIGNMENT_ROW])
                        .mockResolvedValueOnce([
                            PINNED_ROW,
                            { ...PINNED_ROW, id: 'pkg-pinned-2', driver_id: 'drv-8', vehicle_id: 'veh-8' },
                        ]),
                );

                const result = await service.buildOptimizationRequest(runner as never);

                expect(result.pinnedRoutes).toHaveLength(2);
            });

            it('drops a pinned group entirely when every package in it lacks a geocoded location', async () => {
                const runner = makeRunner(
                    jest.fn()
                        .mockResolvedValueOnce([NORMAL_PACKAGE])
                        .mockResolvedValueOnce([ASSIGNMENT_ROW])
                        .mockResolvedValueOnce([
                            { ...PINNED_ROW, customer_lon: null, customer_lat: null },
                        ]),
                );

                const result = await service.buildOptimizationRequest(runner as never);

                expect(result.pinnedRoutes).toHaveLength(0);
            });

            it('excludes a pinned package with a future scheduled_arrival from its route', async () => {
                const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
                const runner = makeRunner(
                    jest.fn()
                        .mockResolvedValueOnce([NORMAL_PACKAGE])
                        .mockResolvedValueOnce([ASSIGNMENT_ROW])
                        .mockResolvedValueOnce([
                            { ...PINNED_ROW, scheduled_arrival: future.toISOString() },
                        ]),
                );

                const result = await service.buildOptimizationRequest(runner as never);

                expect(result.pinnedRoutes).toHaveLength(0);
            });
        });
    });

    // ---------------------------------------------------------------------------
    // insertOptimisedRoutes
    // ---------------------------------------------------------------------------
    describe('insertOptimisedRoutes', () => {
        beforeEach(async () => {
            await service.onApplicationBootstrap();
        });

        it('inserts vrp_optimization (provider vroom) and vrp_solution for an empty route set', async () => {
            const runner = makeRunner();
            chainInsertIds(runner, 'opt-1', 'sol-1');

            await expect(
                service.insertOptimisedRoutes(
                    runner as never,
                    { jobs: [], vehicles: [] },
                    {
                        code: 0,
                        summary: { cost: 0, routes: 0, unassigned: 0 },
                        routes: [],
                        unassigned: [],
                    },
                    {},
                    {},
                    {},
                ),
            ).resolves.not.toThrow();

            expect(runner.manager.insert).toHaveBeenNthCalledWith(
                1,
                VrpOptimization,
                expect.objectContaining({ provider: 'vroom' }),
            );
            expect(runner.manager.insert).toHaveBeenNthCalledWith(
                2,
                VrpSolution,
                expect.objectContaining({ optimizationId: 'opt-1', cost: 0 }),
            );
        });

        it('processes a route with job steps and upserts package assignments', async () => {
            const runner = makeRunner();
            chainInsertIds(runner, 'opt-1', 'sol-1', 'rt-1');

            await service.insertOptimisedRoutes(
                runner as never,
                {
                    jobs: [{ id: 1, service: 900, location: [151.2, -33.8], amount: [1000], priority: 50 }],
                    vehicles: [],
                },
                {
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
                            steps: [
                                {
                                    type: 'job',
                                    id: 1,
                                    location: [151.2, -33.8],
                                    arrival: 0,
                                    duration: 900,
                                    setup: 0,
                                    service: 900,
                                    waiting_time: 0,
                                    load: [0] as never,
                                },
                            ],
                        },
                    ],
                    unassigned: [],
                },
                { 1: 'veh-1' },
                { 1: 'pkg-1' },
                { 1: 'drv-1' },
            );

            // vrp_route inserted with the solution id
            expect(runner.manager.insert).toHaveBeenNthCalledWith(
                3,
                VrpRoute,
                expect.objectContaining({ solutionId: 'sol-1', duration: 3600 }),
            );
            // package_assignment upserted before the route steps insert
            expect(runner.manager.upsert).toHaveBeenCalledWith(
                PackageAssignment,
                [{ packageId: 'pkg-1', vehicleId: 'veh-1', driverId: 'drv-1' }],
                ['packageId'],
            );
            // vrp_route_step batch insert went through runner.query
            const stepInsertCall = runner.query.mock.calls.find((call: unknown[]) =>
                String(call[0]).includes('vrp_route_step'),
            );
            expect(stepInsertCall).toBeDefined();
            // packages marked as processed
            expect(runner.manager.update).toHaveBeenCalledWith(
                Package,
                { id: In(['pkg-1']) },
                { optimisationId: 'opt-1' },
            );
            // and advanced to ASSIGNED via package_timeline
            const timelineCall = runner.query.mock.calls.find((call: unknown[]) =>
                String(call[0]).includes('INSERT INTO package_timeline'),
            );
            expect(timelineCall).toBeDefined();
            expect(timelineCall![1]).toEqual(['pkg-1', 1]);
        });

        it('does not touch package_timeline when no packages were optimised', async () => {
            const runner = makeRunner();
            chainInsertIds(runner, 'opt-1', 'sol-1');

            await service.insertOptimisedRoutes(
                runner as never,
                { jobs: [], vehicles: [] },
                { code: 0, summary: { cost: 0, routes: 0, unassigned: 0 }, routes: [], unassigned: [] },
                {},
                {},
                {},
            );

            const timelineCall = runner.query.mock.calls.find((call: unknown[]) =>
                String(call[0]).includes('INSERT INTO package_timeline'),
            );
            expect(timelineCall).toBeUndefined();
        });

        it('throws when a job step has no corresponding entry in jobMap', async () => {
            const runner = makeRunner();
            chainInsertIds(runner, 'opt-1', 'sol-1', 'rt-1');

            await expect(
                service.insertOptimisedRoutes(
                    runner as never,
                    { jobs: [], vehicles: [] },
                    {
                        code: 0,
                        summary: {},
                        routes: [
                            {
                                vehicle: 1,
                                cost: 0,
                                delivery: [0],
                                pickup: [0],
                                service: 0,
                                duration: 0,
                                waiting_time: 0,
                                steps: [
                                    {
                                        type: 'job',
                                        id: 99, // no mapping in jobMap
                                        location: [151.2, -33.8],
                                        arrival: 0,
                                        duration: 0,
                                        setup: 0,
                                        service: 0,
                                        waiting_time: 0,
                                    },
                                ],
                            },
                        ],
                        unassigned: [],
                    },
                    {},
                    {}, // empty jobMap
                    {},
                ),
            ).rejects.toThrow('Missing package mapping for job id 99');
        });

        it('includes computing_times loading/solving/routing when present in summary', async () => {
            const runner = makeRunner();
            chainInsertIds(runner, 'opt-2', 'sol-2');

            await service.insertOptimisedRoutes(
                runner as never,
                { jobs: [], vehicles: [] },
                {
                    code: 0,
                    summary: {
                        cost: 50,
                        routes: 0,
                        unassigned: 0,
                        // computing_times is not in the typed interface but VROOM includes it
                        computing_times: { loading: 10, solving: 20, routing: 5 },
                    } as never,
                    routes: [],
                    unassigned: [],
                },
                {},
                {},
                {},
            );

            expect(runner.manager.insert).toHaveBeenNthCalledWith(
                2,
                VrpSolution,
                expect.objectContaining({ loadingTime: 10, solvingTime: 20, routingTime: 5 }),
            );
        });

        it('skips steps without a location and coerces a scalar load to an array', async () => {
            const runner = makeRunner();
            chainInsertIds(runner, 'opt-3', 'sol-3', 'rt-3');

            await service.insertOptimisedRoutes(
                runner as never,
                { jobs: [], vehicles: [] },
                {
                    code: 0,
                    summary: {},
                    routes: [
                        {
                            vehicle: 1,
                            cost: 0,
                            delivery: [0],
                            pickup: [0],
                            service: 0,
                            duration: 0,
                            waiting_time: 0,
                            steps: [
                                {
                                    type: 'start',
                                    location: undefined, // skipped
                                    arrival: 0,
                                },
                                {
                                    type: 'start',
                                    location: [151.0, -33.7],
                                    arrival: 0,
                                    duration: 0,
                                    setup: 0,
                                    service: 0,
                                    waiting_time: 0,
                                    load: 42, // scalar load — exercises the non-array branch
                                },
                            ],
                        },
                    ],
                    unassigned: [],
                },
                { 1: 'veh-1' },
                {},
                { 1: 'drv-1' },
            );

            const stepInsertCall = runner.query.mock.calls.find((call: unknown[]) =>
                String(call[0]).includes('vrp_route_step'),
            );
            expect(stepInsertCall).toBeDefined();
            const params = stepInsertCall![1] as unknown[];
            // Only the located step was inserted (13 params per row).
            expect(params).toHaveLength(13);
            // Scalar load 42 was coerced to [42].
            expect(params[12]).toEqual([42]);
        });
    });
});
