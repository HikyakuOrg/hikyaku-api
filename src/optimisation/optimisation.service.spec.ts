import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource, Repository, QueryRunner } from 'typeorm';
import { OptimisationService } from './optimisation.service';
import type { DatabaseService } from '../database/database.service';
import type { VroomService } from '../vroom/vroom.service';
import type { OptimizationResponse } from '../vroom/vroom.types';
import type { OptimisationRun } from 'src/entities/optimisation-run.entity';
import type { AdhocOptimisationDto } from './dto/adhoc-optimisation.dto';

const ORG = 'org-1';
const START = '2026-07-11T08:00:00Z';
const START_EPOCH = Math.floor(Date.parse(START) / 1000);
const SHIFT_WINDOW = 12 * 60 * 60;

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
        .mockResolvedValueOnce(
            rows.vehicle ?? [{ warehouse_id: 'depot-1', ors_vehicle_type: 'driving-car' }],
        )
        .mockResolvedValueOnce(rows.packages ?? []);
    return { query } as unknown as DataSource;
}

/** A valid, unclaimed package row sitting at the requested warehouse. */
function pkg(id: string, lon: number, lat: number, over: Record<string, unknown> = {}) {
    return { id, warehouse_id: 'wh-1', optimisation_id: null, lon, lat, ...over };
}

function makeRunner(): jest.Mocked<Pick<QueryRunner,
    'commitTransaction' | 'rollbackTransaction' | 'release'>> {
    return {
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
    } as never;
}

const baseDto: AdhocOptimisationDto = {
    startDateTime: START,
    startingLocationId: 'wh-1',
    driverId: 'driver-1',
    vehicleId: 'vehicle-1',
    packages: ['pkg-a', 'pkg-b'],
};

const okResponse: OptimizationResponse = {
    code: 0,
    summary: { cost: 100, routes: 1, unassigned: 0 },
    routes: [],
    unassigned: [],
};

describe('OptimisationService.runAdhoc', () => {
    let vroom: jest.Mocked<Pick<VroomService, 'solve'>>;
    let db: jest.Mocked<Pick<DatabaseService, 'beginTransaction' | 'insertAdhocRoutes'>>;
    let runner: ReturnType<typeof makeRunner>;
    const repo = {} as Repository<OptimisationRun>;

    beforeEach(() => {
        runner = makeRunner();
        vroom = { solve: jest.fn().mockResolvedValue(okResponse) };
        db = {
            beginTransaction: jest.fn().mockResolvedValue(runner),
            insertAdhocRoutes: jest.fn().mockResolvedValue({
                optimizationId: 'opt-1',
                routeId: 'route-1',
                unassignedPackageIds: [],
            }),
        };
    });

    function makeService(dataSource: DataSource) {
        return new OptimisationService(
            dataSource,
            repo,
            vroom as unknown as VroomService,
            db as unknown as DatabaseService,
        );
    }

    it('builds a single-vehicle VROOM request and returns the optimisation id', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', 30, 40)],
        });

        const result = await makeService(ds).runAdhoc(ORG, baseDto);

        expect(result).toEqual({
            id: 'opt-1',
            routeId: 'route-1',
            unassignedPackageIds: [],
        });

        const sent = vroom.solve.mock.calls[0][0];
        expect(sent.vehicles).toHaveLength(1);
        const vehicle = sent.vehicles[0];
        expect(vehicle.profile).toBe('auto'); // driving-car → auto
        expect(vehicle.start).toEqual([1, 2]);
        expect(vehicle.end).toEqual([1, 2]);
        expect(vehicle.time_window).toEqual([START_EPOCH, START_EPOCH + SHIFT_WINDOW]);

        expect(sent.jobs).toHaveLength(2);
        expect(sent.jobs[0].location).toEqual([10, 20]);
        expect(sent.jobs[1].location).toEqual([30, 40]);
        expect(sent.jobs.every((j) => j.service === 900)).toBe(true);
        // No capacity dimension so every package is eligible.
        expect(sent.jobs.every((j) => j.amount === undefined)).toBe(true);

        expect(db.insertAdhocRoutes).toHaveBeenCalledTimes(1);
        // Jobs are keyed 1..n and map back to the requested packages in order.
        expect(db.insertAdhocRoutes.mock.calls[0][3]).toEqual({
            1: 'pkg-a',
            2: 'pkg-b',
        });
        const persistOpts = db.insertAdhocRoutes.mock.calls[0][4];
        expect(persistOpts.organisationId).toBe(ORG);
        expect(persistOpts.scheduledStart).toEqual(new Date(START));
        expect(persistOpts.driverId).toBe('driver-1');
        expect(persistOpts.vehicleId).toBe('vehicle-1');

        expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
        expect(runner.release).toHaveBeenCalledTimes(1);
        expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    });

    it('rejects when the warehouse is not in the org', async () => {
        const ds = mockDataSource({ warehouse: [] });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects when the driver is not found in this organisation', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            driver: [],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /Driver not found/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects when the vehicle is not found in this organisation', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            vehicle: [],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /Vehicle not found/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects when the driver and vehicle belong to different warehouses', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            driver: [{ warehouse_id: 'depot-1' }],
            vehicle: [{ warehouse_id: 'depot-2', ors_vehicle_type: 'driving-car' }],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /same warehouse/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects when a requested package is missing or in another org', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-a', 10, 20)], // pkg-b missing
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /unknown package id\(s\): pkg-b/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects a package sitting at a different warehouse', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [
                pkg('pkg-a', 10, 20),
                pkg('pkg-b', 30, 40, { warehouse_id: 'wh-2' }),
            ],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /not at warehouse wh-1: pkg-b/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects a package whose recipient has no location', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', null as never, null as never)],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /no location: pkg-b/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('409s when a package is already claimed by another optimisation', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [
                pkg('pkg-a', 10, 20),
                pkg('pkg-b', 30, 40, { optimisation_id: 'opt-old' }),
            ],
        });
        const err = await makeService(ds).runAdhoc(ORG, baseDto).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as Error).message).toMatch(/pkg-b/);
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('reports every invalid package in one error rather than failing on the first', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-b', 30, 40, { warehouse_id: 'wh-2' })], // pkg-a unknown
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /pkg-a.*pkg-b/,
        );
    });

    it('prefers the 400 over the 409 when the batch has both problems', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-b', 30, 40, { optimisation_id: 'opt-old' })], // pkg-a unknown
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('dedupes repeated package ids into a single job', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-a', 10, 20)],
        });
        await makeService(ds).runAdhoc(ORG, {
            ...baseDto,
            packages: ['pkg-a', 'pkg-a'],
        });
        const sent = vroom.solve.mock.calls[0][0];
        expect(sent.jobs).toHaveLength(1);
    });

    it('rolls back and rethrows when persistence fails', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            packages: [pkg('pkg-a', 10, 20), pkg('pkg-b', 30, 40)],
        });
        db.insertAdhocRoutes.mockRejectedValueOnce(new Error('db boom'));

        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow('db boom');
        expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(runner.commitTransaction).not.toHaveBeenCalled();
        expect(runner.release).toHaveBeenCalledTimes(1);
    });
});
