import { ConflictException } from '@nestjs/common';
import { ShiftPlanWriter, type PlanWrite } from './shift-plan.writer';

const DEPARTURE = Date.parse('2026-09-01T08:00:00Z');

function makeRunner(answers: (sql: string) => unknown = () => []) {
    const log: { sql: string; params: unknown[] }[] = [];
    const query = jest.fn(
        (sql: string, params: unknown[] = [], structured?: boolean) => {
            log.push({ sql, params });
            const rows = answers(sql);
            return Promise.resolve(structured ? { records: rows } : rows);
        },
    );
    return { runner: { query } as never, query, log };
}

function plan(overrides: Partial<PlanWrite> = {}): PlanWrite {
    return {
        optimisationId: 'shift-1',
        routeId: 'route-1',
        solutionId: 'sol-1',
        depot: { lon: 0, lat: 0 },
        departureMs: DEPARTURE,
        driverId: 'driver-1',
        vehicleId: 'vehicle-1',
        reason: 'assign',
        stops: [
            {
                packageId: 'pkg-a',
                lon: 0.01,
                lat: 0,
                arrivalMs: DEPARTURE + 600_000,
                weightG: 2_000,
            },
            {
                packageId: 'pkg-b',
                lon: 0.02,
                lat: 0,
                arrivalMs: DEPARTURE + 1_800_000,
                weightG: 3_000,
            },
        ],
        ...overrides,
    };
}

describe('ShiftPlanWriter', () => {
    const writer = new ShiftPlanWriter();

    describe('ensureRoute', () => {
        it('reuses the shift’s existing solution and route', async () => {
            const { runner, log } = makeRunner((sql) =>
                sql.includes('FROM vrp_solution s')
                    ? [{ route_id: 'route-1', solution_id: 'sol-1' }]
                    : [],
            );

            const result = await writer.ensureRoute(runner, 'shift-1');

            expect(result).toEqual({ routeId: 'route-1', solutionId: 'sol-1' });
            expect(
                log.some((q) => q.sql.includes('INSERT INTO vrp_solution')),
            ).toBe(false);
        });

        it('creates an empty pair for a shift that has none yet', async () => {
            // A shift opened with no packages still needs somewhere to write steps.
            const { runner } = makeRunner((sql) => {
                if (sql.includes('INSERT INTO vrp_solution'))
                    return [{ id: 'sol-new' }];
                if (sql.includes('INSERT INTO vrp_route '))
                    return [{ id: 'route-new' }];
                return [];
            });

            const result = await writer.ensureRoute(runner, 'shift-1');
            expect(result).toEqual({
                routeId: 'route-new',
                solutionId: 'sol-new',
            });
        });
    });

    describe('writePlan', () => {
        it('clears the old steps before writing the new ones', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const del = log.findIndex((q) =>
                q.sql.includes('DELETE FROM vrp_route_step'),
            );
            const ins = log.findIndex((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            expect(del).toBeGreaterThan(-1);
            expect(ins).toBeGreaterThan(del);
        });

        it('writes assignments before the steps that reference them', async () => {
            // vrp_route_step.package_id is a foreign key onto package_assignment.
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const assignments = log.findIndex((q) =>
                q.sql.includes('INSERT INTO package_assignment'),
            );
            const steps = log.findIndex((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            expect(assignments).toBeGreaterThan(-1);
            expect(steps).toBeGreaterThan(assignments);
        });

        it('brackets the job steps with a depot start and a depot end', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const steps = log.find((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            const params = steps?.params ?? [];
            // Four rows of eight params: start, two jobs, end.
            expect(params).toHaveLength(32);
            expect(params[2]).toBe('start');
            expect(params[10]).toBe('job');
            expect(params[26]).toBe('end');
        });

        it('stores arrivals as seconds from departure, the convention everything else reads', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const steps = log.find((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            const params = steps?.params ?? [];
            expect(params[6]).toBe(0); // start
            expect(params[14]).toBe(600); // first job, ten minutes out
            expect(params[22]).toBe(1800); // second job
        });

        it('accumulates the load along the route', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const steps = log.find((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            const params = steps?.params ?? [];
            expect(params[7]).toEqual([0]);
            expect(params[15]).toEqual([2_000]);
            expect(params[23]).toEqual([5_000]);
        });

        it('writes an empty route as just the two depot steps', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan({ stops: [] }));

            const steps = log.find((q) =>
                q.sql.includes('INSERT INTO vrp_route_step'),
            );
            expect(steps?.params).toHaveLength(16);
            expect(
                log.some((q) =>
                    q.sql.includes('INSERT INTO package_assignment'),
                ),
            ).toBe(false);
            expect(
                log.some((q) =>
                    q.sql.includes('INSERT INTO package_delivery_window'),
                ),
            ).toBe(false);
        });

        it('touches the shift row so the revision the clients poll moves', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const touch = log.find((q) =>
                q.sql.includes('UPDATE vrp_optimization'),
            );
            expect(touch).toBeDefined();
            expect(touch?.params[0]).toBe('shift-1');
        });

        it('never inserts a vrp_optimization row', async () => {
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());
            expect(
                log.filter((q) =>
                    /INSERT INTO vrp_optimization\b/i.test(q.sql),
                ),
            ).toHaveLength(0);
        });
    });

    describe('the coverage outcome', () => {
        /** The assignment upsert's parameters, four per stop. */
        const upsertParams = (
            log: { sql: string; params: unknown[] }[],
        ): unknown[] =>
            log.find((q) => q.sql.includes('INSERT INTO package_assignment'))
                ?.params ?? [];

        it('rides on the row that was being written anyway', async () => {
            // One statement, four columns. A second write to record the
            // outcome would be paid inside the per-warehouse advisory lock by
            // every package at the depot, not just the one being placed.
            const { runner, log } = makeRunner();
            await writer.writePlan(
                runner,
                plan({
                    stops: [
                        {
                            packageId: 'pkg-a',
                            lon: 0.01,
                            lat: 0,
                            arrivalMs: DEPARTURE + 600_000,
                            weightG: 2_000,
                            coverageOutcome: 'covered',
                        },
                    ],
                }),
            );

            expect(
                log.filter((q) =>
                    q.sql.includes('INSERT INTO package_assignment'),
                ),
            ).toHaveLength(1);
            expect(upsertParams(log)).toEqual([
                'pkg-a',
                'driver-1',
                'vehicle-1',
                'covered',
            ]);
        });

        it('stamps only the stop it was given, never the rest of the van', async () => {
            // writePlan rewrites every stop on the route. If the outcome went
            // onto all of them, one package joining a van would restamp the
            // whole manifest with a decision nobody took about them.
            const { runner, log } = makeRunner();
            const [first, second] = plan().stops;
            await writer.writePlan(
                runner,
                plan({
                    stops: [{ ...first, coverageOutcome: 'floater' }, second],
                }),
            );

            expect(upsertParams(log)).toEqual([
                'pkg-a',
                'driver-1',
                'vehicle-1',
                'floater',
                'pkg-b',
                'driver-1',
                'vehicle-1',
                null,
            ]);
        });

        it('coalesces on conflict, so a replan cannot erase one', async () => {
            // The replan worker and both hand-edit paths rewrite routes they
            // did not choose the packages for and pass no outcome. An
            // unqualified EXCLUDED assignment would blank the only record of a
            // decision that cannot be recomputed afterwards.
            const { runner, log } = makeRunner();
            await writer.writePlan(runner, plan());

            const upsert = log.find((q) =>
                q.sql.includes('INSERT INTO package_assignment'),
            );
            expect(upsert?.sql).toContain(
                'coverage_outcome = COALESCE(\n' +
                    '                               EXCLUDED.coverage_outcome,\n' +
                    '                               package_assignment.coverage_outcome)',
            );
            expect(upsertParams(log)).toEqual([
                'pkg-a',
                'driver-1',
                'vehicle-1',
                null,
                'pkg-b',
                'driver-1',
                'vehicle-1',
                null,
            ]);
        });
    });

    describe('detach', () => {
        it('does nothing for an empty list', async () => {
            const { runner, query } = makeRunner();
            await writer.detach(runner, [], { incrementEviction: true });
            expect(query).not.toHaveBeenCalled();
        });

        it('deletes the assignment, which cascades the route step', async () => {
            const { runner, log } = makeRunner();
            await writer.detach(runner, ['pkg-a'], { incrementEviction: true });

            expect(log[0].sql).toContain('DELETE FROM package_assignment');
            expect(log[0].params[0]).toEqual(['pkg-a']);
        });

        it('counts an eviction when the package was bumped', async () => {
            const { runner, log } = makeRunner();
            await writer.detach(runner, ['pkg-a'], { incrementEviction: true });

            const update = log.find((q) => q.sql.includes('UPDATE packages'));
            expect(update?.params[1]).toBe(1);
        });

        it('does not count one when a dispatcher moved it by hand', async () => {
            const { runner, log } = makeRunner();
            await writer.detach(runner, ['pkg-a'], {
                incrementEviction: false,
            });

            const update = log.find((q) => q.sql.includes('UPDATE packages'));
            expect(update?.params[1]).toBe(0);
        });

        it('puts the package back to PENDING', async () => {
            // The write that silently did nothing until AllowStatusRevisits: a
            // removed package used to read ASSIGNED forever.
            const { runner, log } = makeRunner();
            await writer.detach(runner, ['pkg-a'], { incrementEviction: true });

            const status = log.find((q) =>
                q.sql.includes('insert_package_timeline'),
            );
            expect(status?.params).toEqual([['pkg-a'], 'PENDING']);
        });
    });

    describe('claimPackages', () => {
        it('does nothing for an empty list', async () => {
            const { runner, query } = makeRunner();
            await writer.claimPackages(runner, 'shift-1', []);
            expect(query).not.toHaveBeenCalled();
        });

        it('claims and advances the status to ASSIGNED', async () => {
            const { runner, log } = makeRunner(() => [{ id: 'pkg-a' }]);
            await writer.claimPackages(runner, 'shift-1', ['pkg-a']);

            const status = log.find((q) =>
                q.sql.includes('insert_package_timeline'),
            );
            expect(status?.params).toEqual([['pkg-a'], 'ASSIGNED']);
        });

        it('is idempotent for a package already on this shift', async () => {
            const { runner, log } = makeRunner(() => [{ id: 'pkg-a' }]);
            await writer.claimPackages(runner, 'shift-1', ['pkg-a']);

            const claim = log.find((q) => q.sql.includes('UPDATE packages'));
            expect(claim?.sql).toContain('optimisation_id = $1');
        });

        it('throws a conflict when another shift claimed one first', async () => {
            const { runner } = makeRunner(() => [{ id: 'pkg-a' }]);
            await expect(
                writer.claimPackages(runner, 'shift-1', ['pkg-a', 'pkg-b']),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('names the packages it lost', async () => {
            const { runner } = makeRunner(() => [{ id: 'pkg-a' }]);
            await expect(
                writer.claimPackages(runner, 'shift-1', ['pkg-a', 'pkg-b']),
            ).rejects.toThrow(/pkg-b/);
        });
    });

    describe('snapshotRevision', () => {
        it('records the revision being superseded, not the one replacing it', async () => {
            const { runner, log } = makeRunner();
            await writer.snapshotRevision(runner, 'shift-1', 7, 'replan');
            expect(log[0].params).toEqual(['shift-1', 7, 'replan']);
        });
    });

    describe('setStatus', () => {
        it('does nothing for an empty list', async () => {
            const { runner, query } = makeRunner();
            await writer.setStatus(runner, [], 'PENDING');
            expect(query).not.toHaveBeenCalled();
        });

        it('goes through insert_package_timeline so the guard lives in one place', async () => {
            const { runner, log } = makeRunner();
            await writer.setStatus(runner, ['pkg-a', 'pkg-b'], 'DELIVERED');
            expect(log[0].sql).toContain('insert_package_timeline');
            expect(log[0].params).toEqual([['pkg-a', 'pkg-b'], 'DELIVERED']);
        });
    });
});
