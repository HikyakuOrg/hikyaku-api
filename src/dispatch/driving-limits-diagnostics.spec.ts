import {
    estimateDrivingSeconds,
    evaluateShiftBreaches,
    percentile,
    summariseDistribution,
    type ProposedLimits,
    type ShiftMetrics,
    type ShiftStepRow,
} from './driving-limits-diagnostics';
import { TIME_PER_STOP } from './insertion';

const NO_LIMITS: ProposedLimits = {
    maxWorkingSeconds: null,
    maxDrivingSeconds: null,
    maxDistanceM: null,
    maxStops: null,
};

function metrics(overrides: Partial<ShiftMetrics> = {}): ShiftMetrics {
    return {
        shiftId: 'shift-1',
        driverId: 'driver-1',
        shiftDate: '2026-09-01',
        workingSeconds: 3 * 3_600,
        distanceM: 100_000,
        stopCount: 10,
        ...overrides,
    };
}

function step(
    overrides: Partial<ShiftStepRow> & { packageId: string },
): ShiftStepRow {
    return {
        stepIndex: 0,
        arrival: 0,
        distanceM: 0,
        ...overrides,
    };
}

describe('estimateDrivingSeconds', () => {
    it('is null when working seconds is not known', () => {
        expect(estimateDrivingSeconds(null, 5)).toBeNull();
    });

    it('subtracts total service time from elapsed working time', () => {
        const working = 3_600 + 5 * TIME_PER_STOP;
        expect(estimateDrivingSeconds(working, 5)).toBe(3_600);
    });

    it('never goes negative when service alone exceeds the elapsed time', () => {
        // Not a real route, but a malformed row must not report negative driving.
        expect(estimateDrivingSeconds(100, 5)).toBe(0);
    });

    it('is the whole elapsed time for a route with no stops', () => {
        expect(estimateDrivingSeconds(1_800, 0)).toBe(1_800);
    });
});

describe('percentile', () => {
    it('throws on an empty sample', () => {
        expect(() => percentile([], 0.5)).toThrow(RangeError);
    });

    it('returns the single value for a sample of one, at any percentile', () => {
        expect(percentile([42], 0)).toBe(42);
        expect(percentile([42], 0.5)).toBe(42);
        expect(percentile([42], 1)).toBe(42);
    });

    it('returns the min and max at p0 and p1', () => {
        const sorted = [1, 2, 3, 4, 5];
        expect(percentile(sorted, 0)).toBe(1);
        expect(percentile(sorted, 1)).toBe(5);
    });

    it('interpolates linearly between the two nearest ranks', () => {
        // Ranks 0..3 for 4 values; p50 lands exactly between index 1 and 2.
        expect(percentile([0, 10, 20, 30], 0.5)).toBe(15);
    });
});

describe('summariseDistribution', () => {
    it('is null for an empty sample rather than zeros', () => {
        // A realised-shift count of zero is "no data yet", not "everyone hit 0".
        expect(summariseDistribution([])).toBeNull();
    });

    it('summarises count, min, p50, p90 and max', () => {
        const values = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10
        const result = summariseDistribution(values);
        expect(result?.count).toBe(10);
        expect(result?.min).toBe(1);
        expect(result?.max).toBe(10);
        expect(result?.p50).toBeCloseTo(5.5, 6);
    });

    it('does not require the input to already be sorted', () => {
        const result = summariseDistribution([30, 10, 20]);
        expect(result).toEqual(summariseDistribution([10, 20, 30]));
    });
});

describe('evaluateShiftBreaches', () => {
    it('reports nothing when no limit is proposed', () => {
        expect(evaluateShiftBreaches(metrics(), NO_LIMITS)).toEqual([]);
    });

    it('reports nothing when every proposed limit is comfortably above the realised figures', () => {
        const limits: ProposedLimits = {
            maxWorkingSeconds: 999_999,
            maxDrivingSeconds: 999_999,
            maxDistanceM: 999_999_999,
            maxStops: 999,
        };
        expect(evaluateShiftBreaches(metrics(), limits)).toEqual([]);
    });

    it('flags a working-time breach against the elapsed departure-to-return figure', () => {
        const shift = metrics({ workingSeconds: 10 * 3_600 });
        const limits: ProposedLimits = {
            ...NO_LIMITS,
            maxWorkingSeconds: 8 * 3_600,
        };
        const breaches = evaluateShiftBreaches(shift, limits);
        expect(breaches).toHaveLength(1);
        expect(breaches[0]).toMatchObject({
            dimension: 'working',
            actual: 10 * 3_600,
            limit: 8 * 3_600,
        });
    });

    it('flags a driving-time breach against the service-subtracted estimate', () => {
        const workingSeconds = 5 * 3_600 + 10 * TIME_PER_STOP;
        const shift = metrics({ workingSeconds, stopCount: 10 });
        const limits: ProposedLimits = {
            ...NO_LIMITS,
            maxDrivingSeconds: 4 * 3_600,
        };
        const breaches = evaluateShiftBreaches(shift, limits);
        expect(breaches).toHaveLength(1);
        expect(breaches[0].dimension).toBe('driving');
        expect(breaches[0].actual).toBe(5 * 3_600);
    });

    it('flags a distance breach against vrp_route.distance_m', () => {
        const shift = metrics({ distanceM: 250_000 });
        const limits: ProposedLimits = { ...NO_LIMITS, maxDistanceM: 200_000 };
        const breaches = evaluateShiftBreaches(shift, limits);
        expect(breaches).toEqual([
            {
                dimension: 'distance',
                actual: 250_000,
                limit: 200_000,
                affectedStopCount: 0,
                affectedPackageIds: [],
            },
        ]);
    });

    it('flags a stop-count breach and names the trailing excess stops', () => {
        const shift = metrics({ stopCount: 12 });
        const limits: ProposedLimits = { ...NO_LIMITS, maxStops: 10 };
        const steps = Array.from({ length: 12 }, (_, i) =>
            step({ packageId: `pkg-${i}`, stepIndex: i }),
        );

        const breaches = evaluateShiftBreaches(shift, limits, steps);

        expect(breaches).toHaveLength(1);
        expect(breaches[0]).toMatchObject({
            dimension: 'stops',
            actual: 12,
            limit: 10,
            affectedStopCount: 2,
        });
        expect(breaches[0].affectedPackageIds).toEqual(['pkg-10', 'pkg-11']);
    });

    it('flags every breaching dimension at once, independently', () => {
        const shift = metrics({
            workingSeconds: 15 * 3_600,
            distanceM: 400_000,
            stopCount: 30,
        });
        const limits: ProposedLimits = {
            maxWorkingSeconds: 10 * 3_600,
            maxDrivingSeconds: null,
            maxDistanceM: 200_000,
            maxStops: 20,
        };
        const breaches = evaluateShiftBreaches(shift, limits);
        expect(breaches.map((b) => b.dimension).sort()).toEqual([
            'distance',
            'stops',
            'working',
        ]);
    });

    it('names the packages past the point cumulative distance crosses the cap', () => {
        const shift = metrics({ distanceM: 30_000, stopCount: 3 });
        const limits: ProposedLimits = { ...NO_LIMITS, maxDistanceM: 20_000 };
        const steps: ShiftStepRow[] = [
            step({ packageId: 'a', stepIndex: 0, distanceM: 10_000 }),
            step({ packageId: 'b', stepIndex: 1, distanceM: 10_000 }), // cumulative 20,000 -- not yet over
            step({ packageId: 'c', stepIndex: 2, distanceM: 10_000 }), // cumulative 30,000 -- crosses here
        ];

        const breaches = evaluateShiftBreaches(shift, limits, steps);

        expect(breaches[0].affectedPackageIds).toEqual(['c']);
    });

    it('without step detail, still reports the breach with zero affected packages', () => {
        const shift = metrics({ distanceM: 250_000 });
        const limits: ProposedLimits = { ...NO_LIMITS, maxDistanceM: 200_000 };
        const breaches = evaluateShiftBreaches(shift, limits); // no steps arg
        expect(breaches[0].affectedPackageIds).toEqual([]);
        expect(breaches[0].affectedStopCount).toBe(0);
    });

    it('never breaches working time when workingSeconds is not known', () => {
        const shift = metrics({ workingSeconds: null });
        const limits: ProposedLimits = { ...NO_LIMITS, maxWorkingSeconds: 1 };
        expect(evaluateShiftBreaches(shift, limits)).toEqual([]);
    });

    it('never breaches distance when distanceM is not known', () => {
        const shift = metrics({ distanceM: null });
        const limits: ProposedLimits = { ...NO_LIMITS, maxDistanceM: 1 };
        expect(evaluateShiftBreaches(shift, limits)).toEqual([]);
    });
});
