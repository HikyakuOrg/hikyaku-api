import { AssignmentService } from './assignment.service';
import { ShiftPlanWriter } from './shift-plan.writer';

/**
 * A stand-in Postgres.
 *
 * Queries are matched on a distinctive fragment of their SQL and answered from a
 * mutable fixture, which keeps the tests readable: each one says what the
 * database contains, not what order the service asks about it in. Every
 * statement is recorded, so the ordering assertions — the lock, the writes, the
 * commit — can be made against the real sequence.
 */
interface DbState {
    package?: Record<string, unknown> | null;
    warehouse?: Record<string, unknown> | null;
    shifts?: Record<string, unknown>[];
    stops?: Record<string, unknown>[];
    freePairs?: Record<string, unknown>[];
    revision?: { revision: number; status: string } | null;
    route?: { route_id: string; solution_id: string } | null;
    claimed?: { id: string }[];
    /**
     * What the coverage query answers with.
     *
     * DEFAULTS TO AN EMPTY `driver_service_area`, which is the state of the live
     * database and the state every test written before service areas existed
     * assumes. An empty link table does not mean "nobody covers anything": it
     * means every driver is a floater, and a floater covers everywhere (see the
     * floater rule in coverage.ts). So the default is one floater row per driver
     * the fixture knows about, which is exactly what the real query returns for
     * an empty table, and under it the whole coverage order collapses back to
     * "step 1 for everything", today's behaviour.
     *
     * Leaving this as literally no rows would ALSO have kept the old tests
     * green, by sending every package down the step-3 fallback to the same
     * shift. That is the trap this default exists to avoid: same answer, wrong
     * path, and no test would have noticed.
     */
    coverage?: CoverageRow[];
    /**
     * Drivers at this warehouse, for the default floater set above. Derived from
     * the shifts and idle pairs in the fixture when it is not given.
     */
    drivers?: string[];
    /** SQL fragment that should throw, and the error to throw. */
    failOn?: { fragment: string; error: Error };
}

/** One row of the coverage query's result, as the pg driver hands it back. */
interface CoverageRow {
    point_index: number | null;
    driver_id: string;
    is_floater: boolean;
}

/** A driver with no service areas at all, who therefore covers everywhere. */
const floaterRow = (driverId: string): CoverageRow => ({
    point_index: null,
    driver_id: driverId,
    is_floater: true,
});

const NOW = new Date('2026-09-01T09:00:00Z');

const WAREHOUSE = {
    id: 'wh-1',
    timezone: 'UTC',
    lon: 0,
    lat: 0,
};

const PACKAGE = {
    id: 'pkg-1',
    organisation_id: 'org-1',
    warehouse_id: 'wh-1',
    optimisation_id: null,
    eviction_count: 0,
    created_at: NOW.toISOString(),
    weight_kg: '2.5',
    scheduled_arrival: null,
    lon: 0.02,
    lat: 0,
};

const SHIFT = {
    id: 'shift-1',
    revision: 3,
    driver_id: 'driver-1',
    vehicle_id: 'vehicle-1',
    scheduled_start: null,
    shift_date: '2026-09-01',
    vehicle_gross_limits: '1000',
    ors_vehicle_type: 'driving-car',
    route_id: 'route-1',
    solution_id: 'sol-1',
};

/** A second van at the same depot, idle. Same revision: the mock serves one. */
const SHIFT_2 = {
    ...SHIFT,
    id: 'shift-2',
    driver_id: 'driver-2',
    vehicle_id: 'vehicle-2',
    route_id: 'route-2',
    solution_id: 'sol-2',
};

/** A stop on route-1, a few metres from where PACKAGE is going. */
function nearbyStop(index: number, lon: number) {
    return {
        route_id: 'route-1',
        step_index: index,
        package_id: `pkg-existing-${index}`,
        lon,
        lat: 0,
        weight_kg: '1',
        scheduled_arrival: null,
        eviction_count: 0,
        created_at: NOW.toISOString(),
        status: 'ASSIGNED',
    };
}

/**
 * Five stops already on shift-1, all within about 100 m of PACKAGE. Inserting
 * among them is nearly free, so shift-1 wins on raw detour by a mile and only
 * the load-spreading penalty can send the package to the empty shift-2.
 */
const CLUSTERED_ON_SHIFT_1 = [0.019, 0.0195, 0.02, 0.0205, 0.021].map(
    (lon, i) => nearbyStop(i, lon),
);

function makeDb(state: DbState) {
    const log: { sql: string; params: unknown[] }[] = [];

    const thePackage = (): Record<string, unknown> | null =>
        state.package === undefined ? PACKAGE : state.package;

    /** Every driver the fixture mentions, whether on a shift or idle. */
    const knownDrivers = (): string[] => {
        if (state.drivers) return state.drivers;
        const ids = new Set<string>();
        for (const row of [...(state.shifts ?? []), ...(state.freePairs ?? [])])
            if (typeof row.driver_id === 'string') ids.add(row.driver_id);
        return [...ids];
    };

    const coverageRows = (): CoverageRow[] =>
        state.coverage ?? knownDrivers().map(floaterRow);

    const answer = (sql: string, params: unknown[]): unknown => {
        if (state.failOn && sql.includes(state.failOn.fragment)) {
            throw state.failOn.error;
        }
        if (
            sql.includes('FROM packages p') &&
            sql.includes('LEFT JOIN package_dimensions')
        ) {
            return state.package === undefined
                ? [PACKAGE]
                : state.package
                  ? [state.package]
                  : [];
        }
        // The lighter lookup assignMany uses to batch its coverage question:
        // same table, none of the joins, so it has to be matched after the one
        // above rather than before it.
        if (sql.includes('FROM packages p')) {
            const row = thePackage();
            return row
                ? [
                      {
                          id: row.id,
                          warehouse_id: row.warehouse_id,
                          lon: row.lon,
                          lat: row.lat,
                      },
                  ]
                : [];
        }
        if (sql.includes('FROM driver_service_area dsa')) {
            return coverageRows();
        }
        if (sql.includes('FROM warehouse w')) {
            return state.warehouse === undefined
                ? [WAREHOUSE]
                : state.warehouse
                  ? [state.warehouse]
                  : [];
        }
        if (
            sql.includes('FROM vrp_optimization v') &&
            sql.includes('JOIN vehicles')
        ) {
            return state.shifts ?? [];
        }
        if (sql.includes('FROM vrp_route_step rs')) return state.stops ?? [];
        if (sql.includes('FROM driver_vehicle_assignment dva')) {
            const pairs = state.freePairs ?? [];
            // Step 2 asks the same question as step 4 with an allowlist bolted
            // on, so the fake has to honour the allowlist or the two steps
            // would be indistinguishable here.
            if (!sql.includes('ANY($4::uuid[])')) return pairs;
            const allowed = new Set((params[3] as string[] | undefined) ?? []);
            return pairs.filter(
                (p) =>
                    typeof p.driver_id === 'string' && allowed.has(p.driver_id),
            );
        }
        if (sql.includes('SELECT revision, status FROM vrp_optimization')) {
            return state.revision === undefined
                ? [{ revision: SHIFT.revision, status: 'planned' }]
                : state.revision
                  ? [state.revision]
                  : [];
        }
        if (
            sql.includes('FROM vrp_solution s') &&
            sql.includes('JOIN vrp_route')
        ) {
            return state.route === undefined
                ? [{ route_id: 'route-1', solution_id: 'sol-1' }]
                : state.route
                  ? [state.route]
                  : [];
        }
        if (sql.includes('INSERT INTO vrp_solution'))
            return [{ id: 'sol-new' }];
        if (sql.includes('INSERT INTO vrp_route '))
            return [{ id: 'route-new' }];
        if (sql.includes('INSERT INTO vrp_optimization\n')) {
            return [{ id: 'shift-new', revision: 1 }];
        }
        if (sql.includes('pg_advisory_xact_lock')) return [];
        return [];
    };

    const query = jest.fn(
        (sql: string, params: unknown[] = [], structured?: boolean) => {
            log.push({ sql, params });
            const rows = answer(sql, params);
            if (structured) {
                if (sql.includes('UPDATE packages')) {
                    const ids = (params[1] as string[]) ?? [];
                    return Promise.resolve({
                        records: state.claimed ?? ids.map((id) => ({ id })),
                    });
                }
                return Promise.resolve({ records: rows });
            }
            return Promise.resolve(rows);
        },
    );

    const runner = {
        query,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        isTransactionActive: true,
    };

    const dataSource = {
        query,
        createQueryRunner: jest.fn(() => runner),
    };

    return { dataSource, runner, query, log };
}

function build(state: DbState = {}) {
    const db = makeDb(state);
    const valhalla = { route: jest.fn() };
    const queue = { enqueueReplan: jest.fn().mockResolvedValue(undefined) };
    const service = new AssignmentService(
        db.dataSource as never,
        valhalla as never,
        queue as never,
        new ShiftPlanWriter(),
    );
    return { service, valhalla, queue, ...db };
}

describe('AssignmentService', () => {
    const originalMode = process.env.ASSIGNMENT_MODE;
    const originalSpread = process.env.LOAD_SPREAD_ENABLED;

    beforeEach(() => {
        // Only the clock is faked. Faking the microtask queue as well makes every
        // `await` in the service wait on a timer that nothing advances, which
        // turns this suite from seconds into minutes.
        jest.useFakeTimers({
            doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
        }).setSystemTime(NOW);
        process.env.ASSIGNMENT_MODE = 'instant';
        // Hermetic: the default is on, but a developer with the kill switch set
        // in their shell should not get a different suite.
        delete process.env.LOAD_SPREAD_ENABLED;
    });

    afterEach(() => {
        jest.useRealTimers();
        if (originalMode === undefined) delete process.env.ASSIGNMENT_MODE;
        else process.env.ASSIGNMENT_MODE = originalMode;
        if (originalSpread === undefined)
            delete process.env.LOAD_SPREAD_ENABLED;
        else process.env.LOAD_SPREAD_ENABLED = originalSpread;
    });

    describe('the feature flag', () => {
        it('does nothing at all in nightly mode — the emergency stop', async () => {
            process.env.ASSIGNMENT_MODE = 'nightly';
            const { service, query } = build();

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome).toEqual({
                outcome: 'skipped',
                reason: 'auto_assign_disabled',
                shift: null,
                evictedPackageIds: [],
            });
            // Inert means inert: not even a read.
            expect(query).not.toHaveBeenCalled();
        });

        it('defaults to instant now that there is no scheduler to fall back to', () => {
            delete process.env.ASSIGNMENT_MODE;
            const { service } = build();
            expect(service.mode).toBe('instant');
        });

        it('treats an unrecognised value as instant rather than silently stopping', () => {
            process.env.ASSIGNMENT_MODE = 'aggressive';
            const { service } = build();
            expect(service.mode).toBe('instant');
        });
    });

    describe('the load-spreading flag', () => {
        it('spreads by default, so an unconfigured deployment gets the fix', () => {
            const { service } = build();
            expect(service.loadSpread).toBe(true);
        });

        it.each(['false', '0'])(
            'is switched off by LOAD_SPREAD_ENABLED=%s',
            (value) => {
                process.env.LOAD_SPREAD_ENABLED = value;
                const { service } = build();
                expect(service.loadSpread).toBe(false);
            },
        );

        it('treats an unrecognised value as on, like ASSIGNMENT_MODE does', () => {
            process.env.LOAD_SPREAD_ENABLED = 'maybe';
            const { service } = build();
            expect(service.loadSpread).toBe(true);
        });

        it('is read per call, so the switch works without a restart', () => {
            const { service } = build();
            expect(service.loadSpread).toBe(true);
            process.env.LOAD_SPREAD_ENABLED = 'false';
            expect(service.loadSpread).toBe(false);
        });
    });

    describe('spreading load across vans', () => {
        // Two shifts at one depot. shift-1 already runs five stops right next to
        // where this package is going, so on raw detour it wins outright. This is
        // the shape of the reported bug: geography alone keeps feeding the van
        // that is already loaded.
        const twoVans = {
            shifts: [SHIFT, SHIFT_2],
            stops: CLUSTERED_ON_SHIFT_1,
        };

        it('sends the package to the empty van, not the one already loaded', async () => {
            const { service } = build(twoVans);

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome.outcome).toBe('assigned');
            expect(outcome.shift?.id).toBe('shift-2');
        });

        it('goes back to the loaded van when the kill switch is set', async () => {
            // The rollback story, end to end: LOAD_SPREAD_ENABLED=false restores
            // the old bin-packing choice with no deploy.
            process.env.LOAD_SPREAD_ENABLED = 'false';
            const { service } = build(twoVans);

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome.outcome).toBe('assigned');
            expect(outcome.shift?.id).toBe('shift-1');
        });

        it('opens no new shift either way, since spreading only reorders what exists', async () => {
            const { service, log } = build(twoVans);
            await service.assign('org-1', 'pkg-1');

            expect(
                log.filter((q) => /INSERT INTO vrp_optimization\b/.test(q.sql)),
            ).toHaveLength(0);
        });
    });

    describe('skipping', () => {
        it('skips a package whose recipient has no geocode', async () => {
            const { service } = build({
                package: { ...PACKAGE, lon: null, lat: null },
            });
            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome.outcome).toBe('skipped');
            expect(outcome.reason).toBe('no_geocode');
        });

        it('skips a package that belongs to another organisation', async () => {
            const { service } = build({ package: null });
            expect((await service.assign('org-1', 'pkg-1')).outcome).toBe(
                'skipped',
            );
        });

        it('skips a package that is already on a shift', async () => {
            const { service } = build({
                package: { ...PACKAGE, optimisation_id: 'shift-9' },
            });
            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome.outcome).toBe('skipped');
        });

        it('defers a package with no warehouse', async () => {
            const { service } = build({
                package: { ...PACKAGE, warehouse_id: null },
            });
            expect((await service.assign('org-1', 'pkg-1')).outcome).toBe(
                'deferred',
            );
        });

        it('defers when the warehouse has no location to route from', async () => {
            const { service } = build({
                warehouse: { ...WAREHOUSE, lon: null, lat: null },
            });
            expect((await service.assign('org-1', 'pkg-1')).outcome).toBe(
                'deferred',
            );
        });
    });

    describe('joining an existing shift', () => {
        it('assigns and reports the driver, the stop and the ETA', async () => {
            const { service, queue, runner } = build({ shifts: [SHIFT] });

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome.outcome).toBe('assigned');
            expect(outcome.shift).toMatchObject({
                id: 'shift-1',
                driverId: 'driver-1',
                vehicleId: 'vehicle-1',
                stopIndex: 0,
                // The touch trigger bumps it as part of the plan write.
                revision: SHIFT.revision + 1,
            });
            expect(outcome.shift?.estimatedArrival).toBeTruthy();
            expect(queue.enqueueReplan).toHaveBeenCalledTimes(1);
            expect(runner.commitTransaction).toHaveBeenCalled();
        });

        it('does NOT insert a vrp_optimization row — that would bill a shift', async () => {
            const { service, log } = build({ shifts: [SHIFT] });
            await service.assign('org-1', 'pkg-1');

            const inserts = log.filter((q) =>
                /INSERT INTO vrp_optimization\b/.test(q.sql),
            );
            expect(inserts).toHaveLength(0);
        });

        it('deletes and re-inserts the whole step list rather than renumbering', async () => {
            const { service, log } = build({
                shifts: [SHIFT],
                stops: [
                    {
                        route_id: 'route-1',
                        step_index: 1,
                        package_id: 'pkg-existing',
                        lon: 0.01,
                        lat: 0,
                        weight_kg: '1',
                        scheduled_arrival: null,
                        eviction_count: 0,
                        created_at: NOW.toISOString(),
                        status: 'ASSIGNED',
                    },
                ],
            });

            await service.assign('org-1', 'pkg-1');

            const deleteIndex = log.findIndex((q) =>
                q.sql.includes('DELETE FROM vrp_route_step'),
            );
            const insertIndex = log.findIndex((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            expect(deleteIndex).toBeGreaterThan(-1);
            expect(insertIndex).toBeGreaterThan(deleteIndex);
            expect(
                log.some((q) => /step_index\s*=\s*step_index/.test(q.sql)),
            ).toBe(false);
        });

        it('snapshots the superseded plan before overwriting it', async () => {
            const { service, log } = build({ shifts: [SHIFT] });
            await service.assign('org-1', 'pkg-1');

            const snapshot = log.find((q) =>
                q.sql.includes('INSERT INTO vrp_optimization_revision'),
            );
            expect(snapshot).toBeDefined();
            expect(snapshot?.params).toContain(SHIFT.revision);
        });

        it('writes the ETA to estimated_arrival, never to the promised deadline', async () => {
            const { service, log } = build({ shifts: [SHIFT] });
            await service.assign('org-1', 'pkg-1');

            const eta = log.find((q) =>
                q.sql.includes('INSERT INTO package_delivery_window'),
            );
            expect(eta?.sql).toContain('estimated_arrival');
            expect(eta?.sql).not.toContain('scheduled_arrival');
        });
    });

    describe('the advisory lock', () => {
        it('is taken before anything is written', async () => {
            const { service, log } = build({ shifts: [SHIFT] });
            await service.assign('org-1', 'pkg-1');

            const lockIndex = log.findIndex((q) =>
                q.sql.includes('pg_advisory_xact_lock'),
            );
            const firstWrite = log.findIndex((q) =>
                /^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql.trim()),
            );
            expect(lockIndex).toBeGreaterThan(-1);
            expect(firstWrite).toBeGreaterThan(lockIndex);
        });

        it('is keyed per warehouse, so two depots never serialise on each other', async () => {
            const { service, log } = build({ shifts: [SHIFT] });
            await service.assign('org-1', 'pkg-1');

            const lock = log.find((q) =>
                q.sql.includes('pg_advisory_xact_lock'),
            );
            expect(lock?.params).toEqual(['assign:wh-1']);
        });

        it('makes NO network call between the lock and the commit', async () => {
            // The constraint the whole two-phase split exists to satisfy: one
            // routing call inside the lock turns a 150 ms hold into ~2 s and caps
            // the warehouse at half a package per second.
            const routingCalls: number[] = [];
            const { service, valhalla, log, runner } = build({
                shifts: [
                    {
                        ...SHIFT,
                        // A tight deadline drags the winner into the grey band, so
                        // the routing call definitely happens somewhere.
                    },
                ],
                package: {
                    ...PACKAGE,
                    // ~6 minutes out, against a ~5.4 minute estimated drive: about
                    // 12% slack, which is inside the grey band.
                    scheduled_arrival: new Date(
                        NOW.getTime() + 370_000,
                    ).toISOString(),
                },
            });
            valhalla.route.mockImplementation(() => {
                routingCalls.push(log.length);
                return Promise.resolve({
                    legs: [{ duration: 60, distance: 1000 }],
                });
            });

            await service.assign('org-1', 'pkg-1');

            expect(valhalla.route).toHaveBeenCalled();
            const lockIndex = log.findIndex((q) =>
                q.sql.includes('pg_advisory_xact_lock'),
            );
            expect(lockIndex).toBeGreaterThan(-1);
            for (const at of routingCalls) {
                expect(at).toBeLessThanOrEqual(lockIndex);
            }
            expect(runner.commitTransaction).toHaveBeenCalled();
        });

        it('does not call the router at all when no deadline is close', async () => {
            const { service, valhalla } = build({ shifts: [SHIFT] });
            await service.assign('org-1', 'pkg-1');
            // The common case is zero HTTP.
            expect(valhalla.route).not.toHaveBeenCalled();
        });

        it('keeps the pessimistic estimate when the router is unreachable', async () => {
            const { service, valhalla } = build({
                shifts: [SHIFT],
                package: {
                    ...PACKAGE,
                    scheduled_arrival: new Date(
                        NOW.getTime() + 370_000,
                    ).toISOString(),
                },
            });
            valhalla.route.mockRejectedValue(new Error('valhalla down'));

            const outcome = await service.assign('org-1', 'pkg-1');
            expect(valhalla.route).toHaveBeenCalled();
            // A router outage must not turn into a failed package creation.
            expect(['assigned', 'assigned_new_shift', 'deferred']).toContain(
                outcome.outcome,
            );
        });
    });

    describe('opening a shift', () => {
        it('opens one when nothing existing fits, and says so', async () => {
            const { service, log } = build({
                shifts: [],
                freePairs: [
                    {
                        driver_id: 'driver-2',
                        vehicle_id: 'vehicle-2',
                        vehicle_gross_limits: '1500',
                        ors_vehicle_type: 'driving-car',
                    },
                ],
            });

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome.outcome).toBe('assigned_new_shift');
            const inserts = log.filter((q) =>
                /INSERT INTO vrp_optimization\b/.test(q.sql),
            );
            // Exactly one billed insert for exactly one new shift.
            expect(inserts).toHaveLength(1);
        });

        it('guards the billed insert with a savepoint', async () => {
            const { service, log } = build({
                shifts: [],
                freePairs: [
                    {
                        driver_id: 'driver-2',
                        vehicle_id: 'vehicle-2',
                        vehicle_gross_limits: '1500',
                        ors_vehicle_type: 'driving-car',
                    },
                ],
            });
            await service.assign('org-1', 'pkg-1');

            const savepoint = log.findIndex((q) =>
                q.sql.includes('SAVEPOINT open_shift'),
            );
            const insert = log.findIndex((q) =>
                /INSERT INTO vrp_optimization\b/.test(q.sql),
            );
            expect(savepoint).toBeGreaterThan(-1);
            expect(insert).toBeGreaterThan(savepoint);
        });

        it('defers rather than failing when the shift allowance is exhausted', async () => {
            const allowance = Object.assign(new Error('over allowance'), {
                code: '23514',
            });
            const { service } = build({
                shifts: [],
                freePairs: [
                    {
                        driver_id: 'driver-2',
                        vehicle_id: 'vehicle-2',
                        vehicle_gross_limits: '1500',
                        ors_vehicle_type: 'driving-car',
                    },
                ],
                failOn: {
                    fragment: 'INSERT INTO vrp_optimization\n',
                    error: allowance,
                },
            });

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome).toEqual({
                outcome: 'deferred',
                reason: 'shift_allowance_exhausted',
                shift: null,
                evictedPackageIds: [],
            });
        });

        it('still defers on 23514 when load spreading had shifts to weigh first', async () => {
            // The allowance path with the new comparator actually in play: two
            // loaded shifts get costed and penalised, neither can take the
            // package (their vans hold 1 g), so openShift runs and the trigger
            // rejects it. Nothing about the penalty should reach the savepoint
            // handling, and this is the test that says so.
            const allowance = Object.assign(new Error('over allowance'), {
                code: '23514',
            });
            const { service, log, runner } = build({
                shifts: [
                    { ...SHIFT, vehicle_gross_limits: '0.001' },
                    { ...SHIFT_2, vehicle_gross_limits: '0.001' },
                ],
                stops: CLUSTERED_ON_SHIFT_1,
                freePairs: [
                    {
                        driver_id: 'driver-3',
                        vehicle_id: 'vehicle-3',
                        vehicle_gross_limits: '1500',
                        ors_vehicle_type: 'driving-car',
                    },
                ],
                failOn: {
                    fragment: 'INSERT INTO vrp_optimization\n',
                    error: allowance,
                },
            });

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome).toEqual({
                outcome: 'deferred',
                reason: 'shift_allowance_exhausted',
                shift: null,
                evictedPackageIds: [],
            });
            // The savepoint absorbed the 23514 rather than the transaction
            // aborting under the advisory lock.
            expect(
                log.some((q) =>
                    q.sql.includes('ROLLBACK TO SAVEPOINT open_shift'),
                ),
            ).toBe(true);
            expect(runner.commitTransaction).not.toHaveBeenCalled();
            expect(runner.release).toHaveBeenCalled();
        });

        it('defers with no_free_driver_vehicle when the depot has no idle pair', async () => {
            const { service } = build({ shifts: [], freePairs: [] });
            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome).toMatchObject({
                outcome: 'deferred',
                reason: 'no_free_driver_vehicle',
            });
        });

        it('defers with no_capacity when shifts exist but none can take it', async () => {
            const { service } = build({
                shifts: [{ ...SHIFT, vehicle_gross_limits: '0.001' }],
                freePairs: [],
            });
            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome).toMatchObject({
                outcome: 'deferred',
                reason: 'no_capacity',
            });
        });
    });

    describe('the revision race', () => {
        it('gives up as deferred after the retries are spent', async () => {
            // The shift always reads back at a different revision than Phase A
            // costed, so every attempt loses the race.
            const { service, runner } = build({
                shifts: [SHIFT],
                revision: { revision: 99, status: 'planned' },
            });

            const outcome = await service.assign('org-1', 'pkg-1');

            expect(outcome).toMatchObject({ outcome: 'deferred' });
            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(runner.commitTransaction).not.toHaveBeenCalled();
        });

        it('refuses to write to a shift that has since been dispatched', async () => {
            const { service, runner } = build({
                shifts: [SHIFT],
                revision: { revision: SHIFT.revision, status: 'dispatched' },
            });

            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome).toMatchObject({ outcome: 'deferred' });
            expect(runner.commitTransaction).not.toHaveBeenCalled();
        });
    });

    describe('failure handling', () => {
        it('degrades an unexpected error to deferred, never to a thrown request', async () => {
            const { service } = build({
                shifts: [SHIFT],
                failOn: {
                    fragment: 'INSERT INTO vrp_route_step',
                    error: new Error('disk on fire'),
                },
            });

            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome).toMatchObject({
                outcome: 'deferred',
                reason: 'no_capacity',
            });
        });

        it('rolls back and releases the connection when a write throws', async () => {
            const { service, runner } = build({
                shifts: [SHIFT],
                failOn: {
                    fragment: 'INSERT INTO vrp_route_step',
                    error: new Error('disk on fire'),
                },
            });

            await service.assign('org-1', 'pkg-1');
            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(runner.release).toHaveBeenCalled();
        });

        it('reports a lost claim race as deferred', async () => {
            const { service } = build({ shifts: [SHIFT], claimed: [] });
            const outcome = await service.assign('org-1', 'pkg-1');
            expect(outcome.outcome).toBe('deferred');
        });
    });

    describe('assignMany', () => {
        it('returns one outcome per package, keyed by id', async () => {
            const { service } = build({ shifts: [SHIFT] });
            const results = await service.assignMany('org-1', [
                'pkg-1',
                'pkg-1',
            ]);
            expect([...results.keys()]).toEqual(['pkg-1']);
        });

        it('takes the warehouse lock once per package, not once per batch item pair', async () => {
            const { service, log } = build({ shifts: [SHIFT] });
            await service.assignMany('org-1', ['pkg-1']);
            const locks = log.filter((q) =>
                q.sql.includes('pg_advisory_xact_lock'),
            );
            expect(locks).toHaveLength(1);
        });
    });
});
