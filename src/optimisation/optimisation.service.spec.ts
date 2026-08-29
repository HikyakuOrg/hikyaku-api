import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { OptimisationService } from './optimisation.service';
import type { AssignmentService } from '../dispatch/assignment.service';
import type { ShiftsService } from '../shifts/shifts.service';
import type { OptimisationRun } from 'src/entities/optimisation-run.entity';
import type { AdhocOptimisationDto } from './dto/adhoc-optimisation.dto';

const ORG = 'org-1';
const START = '2026-07-11T08:00:00Z';

/** Rows the four sequential SELECTs in runAdhoc return, in order. */
function mockDataSource(rows: {
    warehouse?: unknown[];
    driver?: unknown[];
    vehicle?: unknown[];
    packages?: unknown[];
}): DataSource {
    const query = jest
        .fn()
        .mockResolvedValueOnce(rows.warehouse ?? [])
        .mockResolvedValueOnce(rows.driver ?? [{ warehouse_id: 'depot-1' }])
        .mockResolvedValueOnce(rows.vehicle ?? [{ warehouse_id: 'depot-1' }])
        .mockResolvedValueOnce(rows.packages ?? []);
    return { query } as unknown as DataSource;
}

/** A valid, unclaimed package row sitting at the requested warehouse. */
function pkg(id: string, lon: number, lat: number, over: Record<string, unknown> = {}) {
    return { id, warehouse_id: 'wh-1', optimisation_id: null, lon, lat, ...over };
}

const baseDto: AdhocOptimisationDto = {
    startDateTime: START,
    startingLocationId: 'wh-1',
    driverId: 'driver-1',
    vehicleId: 'vehicle-1',
    packages: ['pkg-a', 'pkg-b'],
};

describe('OptimisationService.runAdhoc', () => {
    let shifts: jest.Mocked<Pick<ShiftsService, 'create'>>;
    let assignment: jest.Mocked<Pick<AssignmentService, 'assignToShift'>>;
    const repo = {} as Repository<OptimisationRun>;

    beforeEach(() => {
        shifts = {
            create: jest.fn().mockResolvedValue({
                id: 'shift-1',
                routeId: 'route-1',
                status: 'planned',
            }),
        } as never;
        assignment = {
            assignToShift: jest.fn().mockResolvedValue({
                verdicts: [
                    { packageId: 'pkg-a', added: true, warning: null },
                    { packageId: 'pkg-b', added: true, warning: null },
                ],
                revision: 2,
            }),
        } as never;
    });

    function makeService(dataSource: DataSource) {
        return new OptimisationService(
            dataSource,
            repo,
            shifts as unknown as ShiftsService,
            assignment as unknown as AssignmentService,
        );
    }

    it('opens a shift and hands the packages to the assignment engine', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', 30, 40)],
        });

        const result = await makeService(ds).runAdhoc(ORG, baseDto);

        expect(result).toEqual({
            id: 'shift-1',
            routeId: 'route-1',
            unassignedPackageIds: [],
        });

        // Exactly one shift opened -- this is the one billed insert on the path.
        expect(shifts.create).toHaveBeenCalledTimes(1);
        expect(shifts.create).toHaveBeenCalledWith(ORG, {
            warehouseId: 'wh-1',
            driverId: 'driver-1',
            vehicleId: 'vehicle-1',
            shiftDate: '2026-07-11',
            scheduledStart: START,
        });

        expect(assignment.assignToShift).toHaveBeenCalledWith(ORG, 'shift-1', [
            'pkg-a',
            'pkg-b',
        ]);
    });

    it('files the shift under the warehouse-local day, not the UTC one', async () => {
        // 22:00 UTC is already tomorrow morning in Melbourne, and the shift has
        // to appear on the day the driver thinks they are working.
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'Australia/Melbourne' }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', 30, 40)],
        });

        await makeService(ds).runAdhoc(ORG, {
            ...baseDto,
            startDateTime: '2026-07-11T22:00:00Z',
        });

        expect(shifts.create.mock.calls[0][1].shiftDate).toBe('2026-07-12');
    });

    it('reports a package the shift could not take as unassigned', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', 30, 40)],
        });
        assignment.assignToShift.mockResolvedValue({
            verdicts: [
                { packageId: 'pkg-a', added: true, warning: null },
                { packageId: 'pkg-b', added: false, warning: 'recipient has no geocode' },
            ],
            revision: 2,
        });

        const result = await makeService(ds).runAdhoc(ORG, baseDto);
        expect(result.unassignedPackageIds).toEqual(['pkg-b']);
    });

    it('rejects when the warehouse is not in the org', async () => {
        const ds = mockDataSource({ warehouse: [] });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('rejects when the driver is not found in this organisation', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            driver: [],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /Driver not found/,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('rejects when the vehicle is not found in this organisation', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            vehicle: [],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /Vehicle not found/,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('rejects when the driver and vehicle belong to different warehouses', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            driver: [{ warehouse_id: 'depot-1' }],
            vehicle: [{ warehouse_id: 'depot-2', ors_vehicle_type: 'driving-car' }],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /same warehouse/,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('rejects when a requested package is missing or in another org', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20)], // pkg-b missing
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /unknown package id\(s\): pkg-b/,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('rejects a package sitting at a different warehouse', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [
                pkg('pkg-a', 10, 20),
                pkg('pkg-b', 30, 40, { warehouse_id: 'wh-2' }),
            ],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /not at warehouse wh-1: pkg-b/,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('rejects a package whose recipient has no location', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', null as never, null as never)],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /no location: pkg-b/,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('409s when a package is already claimed by another optimisation', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [
                pkg('pkg-a', 10, 20),
                pkg('pkg-b', 30, 40, { optimisation_id: 'opt-old' }),
            ],
        });
        const err = await makeService(ds).runAdhoc(ORG, baseDto).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as Error).message).toMatch(/pkg-b/);
        expect(shifts.create).not.toHaveBeenCalled();
    });

    it('reports every invalid package in one error rather than failing on the first', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-b', 30, 40, { warehouse_id: 'wh-2' })], // pkg-a unknown
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /pkg-a.*pkg-b/,
        );
    });

    it('prefers the 400 over the 409 when the batch has both problems', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-b', 30, 40, { optimisation_id: 'opt-old' })], // pkg-a unknown
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('dedupes repeated package ids into a single job', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20)],
        });
        await makeService(ds).runAdhoc(ORG, {
            ...baseDto,
            packages: ['pkg-a', 'pkg-a'],
        });
        expect(assignment.assignToShift.mock.calls[0][2]).toEqual(['pkg-a']);
    });

    it('does not assign anything when the shift cannot be opened', async () => {
        // A driver who already has an open shift that day is a 409 now, rather
        // than a second billed shift.
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', 30, 40)],
        });
        shifts.create.mockRejectedValue(new ConflictException('already has a shift'));

        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(assignment.assignToShift).not.toHaveBeenCalled();
    });

    it('validates the whole batch before opening anything', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2, timezone: 'UTC' }],
            packages: [pkg('pkg-a', 10, 20)],
        });

        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(shifts.create).not.toHaveBeenCalled();
    });
});

describe('OptimisationService.triggerRun', () => {
    const repo = {} as Repository<OptimisationRun>;

    /**
     * `triggerRun` runs everything inside `dataSource.transaction`, so the fake
     * hands the callback an entity manager whose `query` answers by SQL
     * fragment and records the sequence.
     */
    function build(state: { warehouse?: unknown[]; recent?: unknown[]; shifts?: unknown[] } = {}) {
        const log: { sql: string; params: unknown[] }[] = [];

        const emQuery = jest.fn((sql: string, params: unknown[] = []) => {
            log.push({ sql, params });
            if (sql.includes('FROM optimisation_run')) return Promise.resolve(state.recent ?? []);
            if (sql.includes('INSERT INTO optimisation_run')) {
                return Promise.resolve([{ id: 'run-1' }]);
            }
            if (sql.includes('FROM vrp_optimization')) {
                return Promise.resolve(state.shifts ?? [{ id: 'shift-1' }, { id: 'shift-2' }]);
            }
            return Promise.resolve([]);
        });

        const query = jest.fn((sql: string) => {
            log.push({ sql, params: [] });
            if (sql.includes('FROM warehouse')) {
                return Promise.resolve(state.warehouse ?? [{ id: 'wh-1' }]);
            }
            return Promise.resolve([]);
        });

        const dataSource = {
            query,
            transaction: jest.fn((cb: (em: unknown) => unknown) => cb({ query: emQuery })),
        } as unknown as DataSource;

        const service = new OptimisationService(
            dataSource,
            repo,
            { create: jest.fn() } as unknown as ShiftsService,
            { assignToShift: jest.fn() } as unknown as AssignmentService,
        );
        return { service, log };
    }

    it('rejects a warehouse outside the organisation', async () => {
        const { service } = build({ warehouse: [] });
        await expect(
            service.triggerRun(ORG, 'user-1', { warehouseId: 'wh-1' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('serialises concurrent clicks on an org advisory lock', async () => {
        const { service, log } = build();
        await service.triggerRun(ORG, 'user-1', { warehouseId: 'wh-1' });

        const lock = log.findIndex((q) => q.sql.includes('pg_advisory_xact_lock'));
        const check = log.findIndex((q) => q.sql.includes('FROM optimisation_run'));
        expect(lock).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(lock);
    });

    it('429s when a run happened inside the rate-limit window', async () => {
        const { service } = build({
            recent: [{ requested_at: new Date().toISOString() }],
        });
        await expect(
            service.triggerRun(ORG, 'user-1', { warehouseId: 'wh-1' }),
        ).rejects.toMatchObject({ status: 429 });
    });

    it('queues one replan per open shift and never inserts a vrp_optimization', async () => {
        // The whole point of the rewrite: re-optimising costs nothing, because
        // every insert into vrp_optimization bills a shift.
        const { service, log } = build();
        await service.triggerRun(ORG, 'user-1', { warehouseId: 'wh-1' });

        const sends = log.filter((q) => q.sql.includes('pgmq.send'));
        expect(sends).toHaveLength(2);
        expect(JSON.parse(sends[0].params[1] as string)).toMatchObject({
            kind: 'replan',
            optimisationId: 'shift-1',
        });
        expect(log.some((q) => /INSERT INTO vrp_optimization\b/i.test(q.sql))).toBe(false);
    });

    it('rings the doorbell once for the batch', async () => {
        const { service, log } = build();
        await service.triggerRun(ORG, 'user-1', { warehouseId: 'wh-1' });
        expect(log.filter((q) => q.sql.includes('pg_notify'))).toHaveLength(1);
    });

    it('marks the run skipped when the warehouse has no open shifts', async () => {
        // Otherwise the dashboard polls a run no consumer will ever pick up.
        const { service, log } = build({ shifts: [] });
        await service.triggerRun(ORG, 'user-1', { warehouseId: 'wh-1' });

        const update = log.find((q) => q.sql.includes("status = 'skipped'"));
        expect(update).toBeDefined();
        expect(log.some((q) => q.sql.includes('pgmq.send'))).toBe(false);
    });
});
