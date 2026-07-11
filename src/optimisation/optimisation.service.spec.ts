import { BadRequestException } from '@nestjs/common';
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

/** Rows the three sequential SELECTs in runAdhoc return, in order. */
function mockDataSource(rows: {
    warehouse?: unknown[];
    vehicleType?: unknown[];
    customers?: unknown[];
}): DataSource {
    const query = jest
        .fn()
        .mockResolvedValueOnce(rows.warehouse ?? [])
        .mockResolvedValueOnce(rows.vehicleType ?? [])
        .mockResolvedValueOnce(rows.customers ?? []);
    return { query } as unknown as DataSource;
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
    vehicleType: 'vt-1',
    startDateTime: START,
    startingLocationId: 'wh-1',
    customers: ['cust-a', 'cust-b'],
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
                unassignedCustomerIds: [],
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
            vehicleType: [{ ors_vehicle_type: 'driving-car' }],
            customers: [
                { id: 'cust-a', lon: 10, lat: 20 },
                { id: 'cust-b', lon: 30, lat: 40 },
            ],
        });

        const result = await makeService(ds).runAdhoc(ORG, baseDto);

        expect(result).toEqual({
            id: 'opt-1',
            routeId: 'route-1',
            unassignedCustomerIds: [],
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
        // No capacity dimension so every customer is eligible.
        expect(sent.jobs.every((j) => j.amount === undefined)).toBe(true);

        expect(db.insertAdhocRoutes).toHaveBeenCalledTimes(1);
        const persistOpts = db.insertAdhocRoutes.mock.calls[0][4];
        expect(persistOpts.organisationId).toBe(ORG);
        expect(persistOpts.scheduledStart).toEqual(new Date(START));

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

    it('rejects when the vehicle type is unknown', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            vehicleType: [],
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('rejects when a requested customer is missing or in another org', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            vehicleType: [{ ors_vehicle_type: 'driving-car' }],
            customers: [{ id: 'cust-a', lon: 10, lat: 20 }], // cust-b missing
        });
        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow(
            /cust-b/,
        );
        expect(vroom.solve).not.toHaveBeenCalled();
    });

    it('dedupes repeated customer ids into a single job', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            vehicleType: [{ ors_vehicle_type: 'driving-car' }],
            customers: [{ id: 'cust-a', lon: 10, lat: 20 }],
        });
        await makeService(ds).runAdhoc(ORG, {
            ...baseDto,
            customers: ['cust-a', 'cust-a'],
        });
        const sent = vroom.solve.mock.calls[0][0];
        expect(sent.jobs).toHaveLength(1);
    });

    it('rolls back and rethrows when persistence fails', async () => {
        const ds = mockDataSource({
            warehouse: [{ lon: 1, lat: 2 }],
            vehicleType: [{ ors_vehicle_type: 'driving-car' }],
            customers: [
                { id: 'cust-a', lon: 10, lat: 20 },
                { id: 'cust-b', lon: 30, lat: 40 },
            ],
        });
        db.insertAdhocRoutes.mockRejectedValueOnce(new Error('db boom'));

        await expect(makeService(ds).runAdhoc(ORG, baseDto)).rejects.toThrow('db boom');
        expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
        expect(runner.commitTransaction).not.toHaveBeenCalled();
        expect(runner.release).toHaveBeenCalledTimes(1);
    });
});
