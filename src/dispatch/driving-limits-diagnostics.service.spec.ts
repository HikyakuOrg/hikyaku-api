import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
    DrivingLimitsDiagnosticsService,
    explainSummary,
    parseProposedLimits,
    parseWindowDays,
} from './driving-limits-diagnostics.service';

const ORG = '11111111-1111-4111-8111-111111111111';

interface Call {
    sql: string;
    params: unknown[];
}

interface ShiftRow {
    shift_id: string;
    driver_id: string | null;
    shift_date: string | null;
    route_id: string;
    distance_m: number | null;
    working_seconds: number | null;
    stop_count: number;
}

interface StepRow {
    step_index: number;
    package_id: string | null;
    arrival: number | null;
    distance_m: number | null;
}

/** A stand-in Postgres, matching on a distinctive fragment of each statement. */
function fakeDataSource(state: {
    shiftRows?: ShiftRow[];
    stepsByRoute?: Record<string, StepRow[]>;
}): { dataSource: DataSource; calls: Call[] } {
    const calls: Call[] = [];

    const query = (sql: string, params: unknown[] = []): Promise<unknown> => {
        calls.push({ sql, params });
        if (sql.includes('JOIN LATERAL')) {
            return Promise.resolve(state.shiftRows ?? []);
        }
        if (sql.includes('SELECT rs.step_index')) {
            const routeId = params[0] as string;
            return Promise.resolve(state.stepsByRoute?.[routeId] ?? []);
        }
        return Promise.resolve([]);
    };

    return { dataSource: { query } as unknown as DataSource, calls };
}

function shift(overrides: Partial<ShiftRow> = {}): ShiftRow {
    return {
        shift_id: 'shift-1',
        driver_id: 'driver-1',
        shift_date: '2026-09-01',
        route_id: 'route-1',
        distance_m: 100_000,
        working_seconds: 3 * 3_600,
        stop_count: 10,
        ...overrides,
    };
}

describe('DrivingLimitsDiagnosticsService', () => {
    const original = process.env.DRIVING_LIMITS;

    afterEach(() => {
        if (original === undefined) delete process.env.DRIVING_LIMITS;
        else process.env.DRIVING_LIMITS = original;
    });

    it('reports zero shifts and a null distribution when nothing realised in the window', async () => {
        delete process.env.DRIVING_LIMITS;
        const { dataSource } = fakeDataSource({ shiftRows: [] });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, {});

        expect(result.shiftCount).toBe(0);
        expect(result.distribution).toBeNull();
        expect(result.breachingShifts).toEqual([]);
        expect(result.drivingLimitsEnabled).toBe(false);
        expect(result.explanation).toContain('No realised shifts');
    });

    it('reports the current DRIVING_LIMITS state', async () => {
        process.env.DRIVING_LIMITS = 'on';
        const { dataSource } = fakeDataSource({ shiftRows: [] });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, {});

        expect(result.drivingLimitsEnabled).toBe(true);
        expect(result.explanation).toContain('currently on');
    });

    it('summarises the realised distribution across every dimension', async () => {
        const { dataSource } = fakeDataSource({
            shiftRows: [
                shift({
                    shift_id: 's1',
                    distance_m: 100_000,
                    working_seconds: 4 * 3_600,
                    stop_count: 10,
                }),
                shift({
                    shift_id: 's2',
                    distance_m: 200_000,
                    working_seconds: 8 * 3_600,
                    stop_count: 20,
                }),
            ],
        });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, {});

        expect(result.shiftCount).toBe(2);
        expect(result.distribution?.distanceM).toEqual({
            count: 2,
            min: 100_000,
            p50: 150_000,
            p90: 190_000,
            max: 200_000,
        });
        expect(result.distribution?.stopCount.max).toBe(20);
    });

    it('does not query step detail at all when no limit is proposed', async () => {
        const { dataSource, calls } = fakeDataSource({
            shiftRows: [shift({ distance_m: 999_999_999 })], // would breach anything
        });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, {});

        expect(result.breachingShifts).toEqual([]);
        expect(calls.some((c) => c.sql.includes('SELECT rs.step_index'))).toBe(
            false,
        );
    });

    it('reports no breach when every proposed limit is comfortably above every shift', async () => {
        const { dataSource, calls } = fakeDataSource({
            shiftRows: [shift()],
        });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, {
            maxDistanceM: '999999999',
        });

        expect(result.breachingShifts).toEqual([]);
        expect(result.totalBreachingShifts).toBe(0);
        expect(result.explanation).toContain('would not have breached');
        // Never needed step detail: nothing breached at the aggregate level.
        expect(calls.some((c) => c.sql.includes('SELECT rs.step_index'))).toBe(
            false,
        );
    });

    it('names a breaching shift, its dimension, and the affected packages', async () => {
        const { dataSource, calls } = fakeDataSource({
            shiftRows: [
                shift({ shift_id: 's1', route_id: 'r1', distance_m: 30_000 }),
                // A second, non-breaching shift, to prove only the breaching
                // one costs a step-detail query.
                shift({ shift_id: 's2', route_id: 'r2', distance_m: 5_000 }),
            ],
            stepsByRoute: {
                r1: [
                    {
                        step_index: 0,
                        package_id: 'a',
                        arrival: 900,
                        distance_m: 10_000,
                    },
                    {
                        step_index: 1,
                        package_id: 'b',
                        arrival: 1800,
                        distance_m: 10_000,
                    },
                    {
                        step_index: 2,
                        package_id: 'c',
                        arrival: 2700,
                        distance_m: 10_000,
                    },
                ],
            },
        });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, { maxDistanceM: '20000' });

        expect(result.breachingShifts).toHaveLength(1);
        expect(result.breachingShifts[0].shiftId).toBe('s1');
        expect(result.breachingShifts[0].dimensions).toEqual([
            {
                dimension: 'distance',
                actual: 30_000,
                limit: 20_000,
                affectedStopCount: 1,
                affectedPackageIds: ['c'],
            },
        ]);

        const stepQueries = calls.filter((c) =>
            c.sql.includes('SELECT rs.step_index'),
        );
        expect(stepQueries).toHaveLength(1);
        expect(stepQueries[0].params).toEqual(['r1']);
    });

    it('echoes back exactly the limits that were proposed', async () => {
        const { dataSource } = fakeDataSource({ shiftRows: [] });
        const service = new DrivingLimitsDiagnosticsService(dataSource);

        const result = await service.summary(ORG, {
            maxDistanceM: '200000',
            maxStops: '25',
        });

        expect(result.proposedLimits).toEqual({
            maxWorkingSeconds: null,
            maxDrivingSeconds: null,
            maxDistanceM: 200_000,
            maxStops: 25,
        });
    });

    it('always reports drivingSecondsIsEstimated', async () => {
        const { dataSource } = fakeDataSource({ shiftRows: [] });
        const service = new DrivingLimitsDiagnosticsService(dataSource);
        const result = await service.summary(ORG, {});
        expect(result.drivingSecondsIsEstimated).toBe(true);
    });
});

describe('parseWindowDays', () => {
    it('defaults to 30 when not given', () => {
        expect(parseWindowDays(undefined)).toBe(30);
    });

    it('accepts a value in range', () => {
        expect(parseWindowDays('14')).toBe(14);
    });

    it.each(['0', '31', '-1', 'abc', '7.5'])('rejects %p', (value) => {
        expect(() => parseWindowDays(value)).toThrow(BadRequestException);
    });
});

describe('parseProposedLimits', () => {
    it('is all-null when nothing is proposed', () => {
        expect(parseProposedLimits({})).toEqual({
            maxWorkingSeconds: null,
            maxDrivingSeconds: null,
            maxDistanceM: null,
            maxStops: null,
        });
    });

    it('parses every field independently', () => {
        expect(
            parseProposedLimits({
                maxWorkingSeconds: '36000',
                maxDrivingSeconds: '28800',
                maxDistanceM: '250000',
                maxStops: '40',
            }),
        ).toEqual({
            maxWorkingSeconds: 36_000,
            maxDrivingSeconds: 28_800,
            maxDistanceM: 250_000,
            maxStops: 40,
        });
    });

    it.each(['0', '-5', 'abc', '3.5'])(
        'rejects a non-positive or non-integer value: %p',
        (value) => {
            expect(() => parseProposedLimits({ maxStops: value })).toThrow(
                BadRequestException,
            );
        },
    );
});

describe('explainSummary', () => {
    it('says nothing was realised, when there was nothing', () => {
        expect(
            explainSummary({
                windowDays: 30,
                shiftCount: 0,
                hasProposal: false,
                breachingShifts: [],
                drivingLimitsEnabled: false,
            }),
        ).toContain('No realised shifts');
    });

    it('reports the shift count without a proposal verdict when none was asked', () => {
        const sentence = explainSummary({
            windowDays: 30,
            shiftCount: 12,
            hasProposal: false,
            breachingShifts: [],
            drivingLimitsEnabled: false,
        });
        expect(sentence).toContain('12 realised shift(s)');
        expect(sentence).not.toContain('breach');
    });

    it('says nothing would have breached, when nothing did', () => {
        expect(
            explainSummary({
                windowDays: 30,
                shiftCount: 12,
                hasProposal: true,
                breachingShifts: [],
                drivingLimitsEnabled: false,
            }),
        ).toContain('would not have breached');
    });

    it('names the breach count and the affected package total', () => {
        const sentence = explainSummary({
            windowDays: 30,
            shiftCount: 12,
            hasProposal: true,
            breachingShifts: [
                {
                    shiftId: 's1',
                    driverId: 'd1',
                    shiftDate: '2026-09-01',
                    dimensions: [
                        {
                            dimension: 'distance',
                            actual: 1,
                            limit: 1,
                            affectedStopCount: 3,
                            affectedPackageIds: ['a', 'b', 'c'],
                        },
                    ],
                },
            ],
            drivingLimitsEnabled: false,
        });
        expect(sentence).toContain('breached 1 of them');
        expect(sentence).toContain('3 package(s)');
    });

    it('always names the current flag state', () => {
        expect(
            explainSummary({
                windowDays: 30,
                shiftCount: 0,
                hasProposal: false,
                breachingShifts: [],
                drivingLimitsEnabled: true,
            }),
        ).toContain('currently on');
    });
});
