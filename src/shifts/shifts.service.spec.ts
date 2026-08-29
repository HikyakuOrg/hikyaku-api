import {
    BadRequestException,
    ConflictException,
    HttpStatus,
    NotFoundException,
} from '@nestjs/common';
import { ShiftsService } from './shifts.service';

const SHIFT_ROW = {
    id: 'shift-1',
    status: 'planned',
    organisation_id: 'org-1',
    warehouse_id: 'wh-1',
    driver_id: 'driver-1',
    vehicle_id: 'vehicle-1',
    shift_date: '2026-09-01',
    scheduled_start: null,
    route_id: 'route-1',
    stop_count: '3',
    revision: 5,
    updated_at: '2026-09-01T09:00:00.000Z',
};

interface State {
    warehouse?: unknown[];
    driver?: unknown[];
    vehicle?: unknown[];
    clash?: unknown[];
    shift?: unknown[];
    insertError?: Error;
    lockedStatus?: string;
}

function build(state: State = {}) {
    const log: { sql: string; params: unknown[] }[] = [];

    const answer = (sql: string): unknown[] => {
        if (sql.includes('FROM warehouse WHERE id')) {
            return state.warehouse ?? [{ id: 'wh-1' }];
        }
        if (sql.includes('FROM drivers WHERE id')) {
            return state.driver ?? [{ warehouse_id: 'wh-1' }];
        }
        if (sql.includes('FROM vehicles')) {
            return state.vehicle ?? [{ warehouse_id: 'wh-1' }];
        }
        if (sql.includes('SELECT id, driver_id, vehicle_id')) return state.clash ?? [];
        if (sql.includes('INSERT INTO vrp_optimization')) {
            if (state.insertError) throw state.insertError;
            return [{ id: 'shift-new' }];
        }
        if (sql.includes('SELECT status FROM vrp_optimization')) {
            return [{ status: state.lockedStatus ?? 'planned' }];
        }
        if (sql.includes('FROM vrp_optimization v')) return state.shift ?? [SHIFT_ROW];
        if (sql.includes('FROM vrp_solution s')) {
            return [{ route_id: 'route-1', solution_id: 'sol-1' }];
        }
        return [];
    };

    const query = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        try {
            return Promise.resolve(answer(sql));
        } catch (err) {
            return Promise.reject(err);
        }
    });

    const runner = {
        query,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        isTransactionActive: true,
    };
    const dataSource = { query, createQueryRunner: jest.fn(() => runner) };

    const assignment = {
        assignToShift: jest.fn().mockResolvedValue({
            verdicts: [{ packageId: 'pkg-1', added: true, warning: null }],
            revision: 6,
        }),
        removeFromShift: jest.fn().mockResolvedValue({ revision: 6 }),
    };
    const planWriter = {
        ensureRoute: jest
            .fn()
            .mockResolvedValue({ routeId: 'route-1', solutionId: 'sol-1' }),
    };

    const service = new ShiftsService(
        dataSource as never,
        assignment as never,
        planWriter as never,
    );
    return { service, assignment, planWriter, runner, log };
}

describe('ShiftsService', () => {
    describe('create', () => {
        it('opens a planned shift with real columns, not a _meta blob', async () => {
            const { service, log } = build();
            const shift = await service.create('org-1', {
                warehouseId: 'wh-1',
                driverId: 'driver-1',
                vehicleId: 'vehicle-1',
                shiftDate: '2026-09-01',
            });

            const insert = log.find((q) => q.sql.includes('INSERT INTO vrp_optimization'));
            expect(insert?.sql).toContain('driver_id');
            expect(insert?.sql).toContain('shift_date');
            expect(insert?.params).toEqual(
                expect.arrayContaining(['driver-1', 'vehicle-1', 'wh-1', '2026-09-01']),
            );
            expect(shift.status).toBe('planned');
        });

        it('gives the empty shift a route to write steps into', async () => {
            const { service, planWriter } = build();
            await service.create('org-1', {
                warehouseId: 'wh-1',
                driverId: 'driver-1',
                vehicleId: 'vehicle-1',
                shiftDate: '2026-09-01',
            });
            expect(planWriter.ensureRoute).toHaveBeenCalled();
        });

        it('takes the warehouse lock, because assignment also opens shifts', async () => {
            const { service, log } = build();
            await service.create('org-1', {
                warehouseId: 'wh-1',
                driverId: 'driver-1',
                vehicleId: 'vehicle-1',
                shiftDate: '2026-09-01',
            });
            const lock = log.find((q) => q.sql.includes('pg_advisory_xact_lock'));
            expect(lock?.params).toEqual(['assign:wh-1']);
        });

        it.each([
            ['warehouse', { warehouse: [] }],
            ['driver', { driver: [] }],
            ['vehicle', { vehicle: [] }],
        ])('reports an unknown %s as a 400, never as cross-org detail', async (_what, state) => {
            const { service } = build(state as State);
            await expect(
                service.create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('refuses a driver and vehicle from different depots', async () => {
            // package_assignment carries enforce_driver_vehicle_warehouse; better
            // a clear 400 now than a raw constraint error at the first package.
            const { service } = build({ vehicle: [{ warehouse_id: 'wh-2' }] });
            await expect(
                service.create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                }),
            ).rejects.toThrow(/same|both belong/i);
        });

        it('409s when that driver already has an open shift that day', async () => {
            const { service } = build({
                clash: [{ id: 'shift-x', driver_id: 'driver-1', vehicle_id: 'other' }],
            });
            await expect(
                service.create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                }),
            ).rejects.toThrow(/driver already has an open shift/);
        });

        it('409s when the vehicle is the one already busy', async () => {
            const { service } = build({
                clash: [{ id: 'shift-x', driver_id: 'other', vehicle_id: 'vehicle-1' }],
            });
            await expect(
                service.create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                }),
            ).rejects.toThrow(/vehicle already has an open shift/);
        });

        it('409s when the unique index catches a race the check could not', async () => {
            const { service } = build({
                insertError: Object.assign(new Error('duplicate key'), {
                    code: '23505',
                }),
            });
            await expect(
                service.create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                }),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('402s when the organisation is out of free shifts', async () => {
            // enforce_shift_allowance raises 23514. 402, not 403: the caller has
            // done nothing wrong, the organisation needs to pay.
            const { service } = build({
                insertError: Object.assign(new Error('You have used your 30 free shifts'), {
                    code: '23514',
                }),
            });
            await expect(
                service.create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                }),
            ).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
        });

        it('rolls back when the insert fails for any other reason', async () => {
            const { service, runner } = build({
                insertError: new Error('disk on fire'),
            });
            await service
                .create('org-1', {
                    warehouseId: 'wh-1',
                    driverId: 'driver-1',
                    vehicleId: 'vehicle-1',
                    shiftDate: '2026-09-01',
                })
                .catch(() => undefined);
            expect(runner.rollbackTransaction).toHaveBeenCalled();
        });
    });

    describe('version', () => {
        it('answers with the revision and the stop count, and nothing else', async () => {
            const { service } = build();
            const version = await service.version('org-1', 'shift-1');
            expect(version).toEqual({
                id: 'shift-1',
                revision: 5,
                updatedAt: '2026-09-01T09:00:00.000Z',
                stopCount: 3,
                status: 'planned',
            });
        });

        it('404s for a shift in another organisation', async () => {
            const { service } = build({ shift: [] });
            await expect(service.version('org-1', 'shift-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('dispatch', () => {
        it('closes a planned shift to further automatic assignment', async () => {
            const { service, log } = build();
            await service.dispatch('org-1', 'shift-1');

            const update = log.find(
                (q) => q.sql.includes('UPDATE vrp_optimization') && q.sql.includes('dispatched'),
            );
            expect(update).toBeDefined();
        });

        it('locks the row first, so two dispatchers cannot both win', async () => {
            const { service, log } = build();
            await service.dispatch('org-1', 'shift-1');

            const select = log.findIndex((q) => q.sql.includes('FOR UPDATE'));
            const update = log.findIndex((q) => q.sql.includes('UPDATE vrp_optimization'));
            expect(select).toBeGreaterThan(-1);
            expect(update).toBeGreaterThan(select);
        });

        it('409s for a shift that is not planned', async () => {
            const { service } = build({ lockedStatus: 'completed' });
            await expect(service.dispatch('org-1', 'shift-1')).rejects.toBeInstanceOf(
                ConflictException,
            );
        });
    });

    describe('package edits', () => {
        it('returns the rewritten plan with a verdict per package', async () => {
            const { service, assignment } = build();
            const plan = await service.addPackages('org-1', 'shift-1', {
                packageIds: ['pkg-1'],
            });

            expect(assignment.assignToShift).toHaveBeenCalledWith('org-1', 'shift-1', [
                'pkg-1',
            ]);
            expect(plan.packages).toEqual([
                { packageId: 'pkg-1', added: true, warning: null },
            ]);
            expect(plan.shift.id).toBe('shift-1');
        });

        it('reports a removal as a plan, not as a bare 204', async () => {
            const { service, assignment } = build();
            const plan = await service.removePackage('org-1', 'shift-1', 'pkg-1');

            expect(assignment.removeFromShift).toHaveBeenCalledWith(
                'org-1',
                'shift-1',
                'pkg-1',
            );
            expect(plan.packages).toEqual([
                { packageId: 'pkg-1', added: false, warning: null },
            ]);
        });
    });

    describe('get', () => {
        it('maps the row to the wire shape', async () => {
            const { service } = build();
            expect(await service.get('org-1', 'shift-1')).toEqual({
                id: 'shift-1',
                status: 'planned',
                organisationId: 'org-1',
                warehouseId: 'wh-1',
                driverId: 'driver-1',
                vehicleId: 'vehicle-1',
                shiftDate: '2026-09-01',
                scheduledStart: null,
                routeId: 'route-1',
                stopCount: 3,
                revision: 5,
                updatedAt: '2026-09-01T09:00:00.000Z',
            });
        });

        it('renders a scheduled start as ISO 8601', async () => {
            // pg hands back a Date for a timestamptz column, not a string.
            const { service } = build({
                shift: [
                    { ...SHIFT_ROW, scheduled_start: new Date('2026-09-01T22:00:00Z') },
                ],
            });
            const shift = await service.get('org-1', 'shift-1');
            expect(shift.scheduledStart).toBe('2026-09-01T22:00:00.000Z');
        });
    });
});
