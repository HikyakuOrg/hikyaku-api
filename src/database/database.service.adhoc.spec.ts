import type { QueryRunner } from 'typeorm';
import { DatabaseService } from './database.service';
import type { OptimizationResponse } from '../vroom/vroom.types';

const START = '2026-07-11T08:00:00Z';
const START_EPOCH = Math.floor(Date.parse(START) / 1000);

/**
 * QueryRunner test double: manager.insert returns a deterministic id per
 * entity, and query() records the raw SQL calls (step batch + unassigned).
 */
function makeRunner() {
    const idByEntity: Record<string, string> = {
        VrpOptimization: 'opt-1',
        VrpSolution: 'sol-1',
        VrpRoute: 'route-1',
    };
    const insert = jest.fn((entity: { name: string }) =>
        Promise.resolve({ identifiers: [{ id: idByEntity[entity.name] }] }),
    );
    const query = jest.fn().mockResolvedValue([]);
    const runner = { manager: { insert }, query } as unknown as QueryRunner;
    return { runner, insert, query };
}

function newService(): DatabaseService {
    // insertAdhocRoutes only touches the passed-in runner; the injected
    // DataSource/repositories are irrelevant, so stub them.
    return new DatabaseService(
        {} as never, {} as never, {} as never, {} as never,
        {} as never, {} as never, {} as never,
    );
}

describe('DatabaseService.insertAdhocRoutes', () => {
    const response: OptimizationResponse = {
        code: 0,
        summary: { cost: 100, routes: 1, unassigned: 1, duration: 1500, service: 900 },
        routes: [
            {
                vehicle: 1,
                cost: 100,
                steps: [
                    { type: 'start', arrival: START_EPOCH, location: [1, 2] },
                    { type: 'job', id: 1, arrival: START_EPOCH + 600, location: [10, 20], service: 900 },
                    { type: 'end', arrival: START_EPOCH + 1500, location: [1, 2] },
                ],
            },
        ],
        unassigned: [{ id: 2, location: [30, 40] }],
    };
    const jobCustomerMap = { 1: 'cust-a', 2: 'cust-b' };

    it('persists the run and returns the ids, mapping unassigned back to customers', async () => {
        const { runner, insert } = makeRunner();
        const svc = newService();

        const result = await svc.insertAdhocRoutes(
            runner,
            { jobs: [], vehicles: [] },
            response,
            jobCustomerMap,
            { organisationId: 'org-1', scheduledStart: new Date(START) },
        );

        expect(result).toEqual({
            optimizationId: 'opt-1',
            routeId: 'route-1',
            unassignedCustomerIds: ['cust-b'],
        });

        const optInsert = insert.mock.calls.find((c) => c[0].name === 'VrpOptimization');
        expect(optInsert?.[1]).toMatchObject({
            provider: 'vroom',
            organisationId: 'org-1',
            scheduledStart: new Date(START),
        });
    });

    it('writes every step with a null package_id and relative-from-departure arrivals', async () => {
        const { runner, query } = makeRunner();
        const svc = newService();

        await svc.insertAdhocRoutes(
            runner,
            { jobs: [], vehicles: [] },
            response,
            jobCustomerMap,
            { organisationId: 'org-1', scheduledStart: new Date(START) },
        );

        const stepCall = query.mock.calls.find((c) =>
            String(c[0]).includes('INSERT INTO vrp_route_step'),
        );
        expect(stepCall).toBeDefined();
        const params = stepCall![1] as unknown[];

        // 13 params per row; package_id at row-offset 4, arrival at offset 7.
        const PARAMS_PER_ROW = 13;
        const rows = params.length / PARAMS_PER_ROW;
        expect(rows).toBe(3);
        for (let r = 0; r < rows; r++) {
            expect(params[r * PARAMS_PER_ROW + 4]).toBeNull(); // package_id
        }
        expect(params[0 * PARAMS_PER_ROW + 7]).toBe(0);    // start → departure baseline
        expect(params[1 * PARAMS_PER_ROW + 7]).toBe(600);  // job arrival relative
        expect(params[2 * PARAMS_PER_ROW + 7]).toBe(1500); // end arrival relative
    });

    it('inserts unassigned jobs with their geometry', async () => {
        const { runner, query } = makeRunner();
        const svc = newService();

        await svc.insertAdhocRoutes(
            runner,
            { jobs: [], vehicles: [] },
            response,
            jobCustomerMap,
            { organisationId: 'org-1', scheduledStart: new Date(START) },
        );

        const unassignedCall = query.mock.calls.find((c) =>
            String(c[0]).includes('INSERT INTO vrp_unassigned_job'),
        );
        expect(unassignedCall).toBeDefined();
        expect(unassignedCall![1]).toEqual(['sol-1', 2, 30, 40, 'job']);
    });

    it('returns a null routeId when there are no routes', async () => {
        const { runner } = makeRunner();
        const svc = newService();

        const result = await svc.insertAdhocRoutes(
            runner,
            { jobs: [], vehicles: [] },
            { code: 0, summary: { unassigned: 0 }, routes: [], unassigned: [] },
            {},
            { organisationId: 'org-1', scheduledStart: new Date(START) },
        );

        expect(result.routeId).toBeNull();
        expect(result.unassignedCustomerIds).toEqual([]);
    });
});
