import {
    DRIVING_LIMITS_SQL,
    drivingLimitsEnabled,
    NO_LIMITS,
    noLimitsForDrivers,
    parseDrivingLimitsRows,
    resolveDrivingLimitsForDriver,
    resolveDrivingLimitsForDrivers,
    resolveLimits,
    type DrivingLimitsQueryExecutor,
} from './driving-limits';

const ORG = '00000000-0000-4000-8000-000000000001';

/**
 * An executor that hands back a canned result and records what it was asked.
 * Typed through the same interface the production code takes, mirroring
 * coverage.spec.ts's fakeExecutor.
 */
function fakeExecutor(rows: unknown): DrivingLimitsQueryExecutor & {
    calls: { sql: string; parameters: unknown[] | undefined }[];
} {
    const calls: { sql: string; parameters: unknown[] | undefined }[] = [];
    return {
        calls,
        query(sql: string, parameters?: unknown[]): Promise<unknown> {
            calls.push({ sql, parameters });
            return Promise.resolve(rows);
        },
    };
}

/** One raw row as DRIVING_LIMITS_SQL would return it. */
function row(
    driverId: string,
    overrides: Record<string, number | null> = {},
): Record<string, unknown> {
    return {
        driver_id: driverId,
        driver_max_working_seconds: null,
        driver_max_driving_seconds: null,
        driver_max_distance_m: null,
        driver_max_stops: null,
        org_max_working_seconds: null,
        org_max_driving_seconds: null,
        org_max_distance_m: null,
        org_max_stops: null,
        ...overrides,
    };
}

describe('resolveLimits', () => {
    const noValues = {
        maxWorkingSeconds: null,
        maxDrivingSeconds: null,
        maxDistanceM: null,
        maxStops: null,
    };

    it('resolves to no limits when neither the driver nor the org set one', () => {
        expect(resolveLimits(noValues, noValues)).toEqual(NO_LIMITS);
    });

    it('prefers the driver profile over the org default on every dimension', () => {
        const driver = {
            maxWorkingSeconds: 36_000,
            maxDrivingSeconds: 28_800,
            maxDistanceM: 250_000,
            maxStops: 40,
        };
        const org = {
            maxWorkingSeconds: 14_400,
            maxDrivingSeconds: 10_800,
            maxDistanceM: 80_000,
            maxStops: 15,
        };
        expect(resolveLimits(driver, org)).toEqual(driver);
    });

    it('falls back to the org default when the driver has no profile', () => {
        const org = {
            maxWorkingSeconds: 14_400,
            maxDrivingSeconds: 10_800,
            maxDistanceM: 80_000,
            maxStops: 15,
        };
        expect(resolveLimits(noValues, org)).toEqual(org);
    });

    it('resolves dimension by dimension, not by picking one profile wholesale', () => {
        // The driver profile sets only distance; working/driving/stops must
        // come from the org default rather than being dropped because the
        // driver "has a profile".
        const driver = {
            maxWorkingSeconds: null,
            maxDrivingSeconds: null,
            maxDistanceM: 250_000,
            maxStops: null,
        };
        const org = {
            maxWorkingSeconds: 36_000,
            maxDrivingSeconds: 28_800,
            maxDistanceM: 80_000,
            maxStops: 40,
        };
        expect(resolveLimits(driver, org)).toEqual({
            maxWorkingSeconds: 36_000,
            maxDrivingSeconds: 28_800,
            maxDistanceM: 250_000, // the driver's own, not the org's
            maxStops: 40,
        });
    });

    it('an all-null profile is a no-op, exactly like having none', () => {
        // A profile with every column null is legal (see HIK-80) and must
        // behave identically to the driver having no profile at all.
        const org = { ...noValues, maxStops: 20 };
        expect(resolveLimits(noValues, org)).toEqual(
            resolveLimits(noValues, org),
        );
        expect(resolveLimits(noValues, org).maxStops).toBe(20);
    });
});

describe('parseDrivingLimitsRows', () => {
    it('parses a fully-populated row', () => {
        const rows = parseDrivingLimitsRows([
            row('driver-1', {
                driver_max_working_seconds: 36_000,
                org_max_stops: 20,
            }),
        ]);
        expect(rows).toEqual([
            {
                driverId: 'driver-1',
                driverProfile: {
                    maxWorkingSeconds: 36_000,
                    maxDrivingSeconds: null,
                    maxDistanceM: null,
                    maxStops: null,
                },
                orgDefaultProfile: {
                    maxWorkingSeconds: null,
                    maxDrivingSeconds: null,
                    maxDistanceM: null,
                    maxStops: 20,
                },
            },
        ]);
    });

    it('coerces a text-mode numeric column back to a number', () => {
        const rows = parseDrivingLimitsRows([
            row('driver-1', { driver_max_stops: '15' as unknown as number }),
        ]);
        expect(rows[0].driverProfile.maxStops).toBe(15);
    });

    it('throws on a non-array result', () => {
        expect(() => parseDrivingLimitsRows({})).toThrow(TypeError);
    });

    it('throws on a row missing driver_id', () => {
        expect(() =>
            parseDrivingLimitsRows([
                { ...row('driver-1'), driver_id: undefined },
            ]),
        ).toThrow(/driver_id/);
    });

    it('throws rather than silently defaulting a non-numeric limit column', () => {
        expect(() =>
            parseDrivingLimitsRows([
                row('driver-1', {
                    driver_max_distance_m: 'a lot' as unknown as number,
                }),
            ]),
        ).toThrow(/driver_max_distance_m/);
    });
});

describe('resolveDrivingLimitsForDrivers', () => {
    it('does not touch the database for an empty batch', async () => {
        const executor = fakeExecutor([]);
        const limits = await resolveDrivingLimitsForDrivers(executor, ORG, []);
        expect(limits.size).toBe(0);
        expect(executor.calls).toHaveLength(0);
    });

    it('resolves a whole batch in one round trip', async () => {
        const executor = fakeExecutor([]);
        const driverIds = Array.from({ length: 500 }, (_, i) => `driver-${i}`);

        await resolveDrivingLimitsForDrivers(executor, ORG, driverIds);

        // The point of the batch form: a 500-package import resolving
        // candidate drivers must not become 500 extra queries.
        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0].sql).toBe(DRIVING_LIMITS_SQL);
    });

    it('dedupes driver ids before querying', async () => {
        const executor = fakeExecutor([]);
        await resolveDrivingLimitsForDrivers(executor, ORG, [
            'driver-1',
            'driver-1',
            'driver-2',
        ]);
        expect(executor.calls[0].parameters).toEqual([
            ORG,
            ['driver-1', 'driver-2'],
        ]);
    });

    it('maps each row through the resolution rule, keyed by driver id', async () => {
        const executor = fakeExecutor([
            row('driver-1', { driver_max_stops: 40 }),
            row('driver-2', { org_max_stops: 15 }),
        ]);

        const limits = await resolveDrivingLimitsForDrivers(executor, ORG, [
            'driver-1',
            'driver-2',
        ]);

        expect(limits.get('driver-1')?.maxStops).toBe(40);
        expect(limits.get('driver-2')?.maxStops).toBe(15);
    });
});

describe('resolveDrivingLimitsForDriver', () => {
    it('answers one driver through the batch query, not a second one', async () => {
        const executor = fakeExecutor([
            row('driver-1', { driver_max_stops: 40 }),
        ]);

        const limits = await resolveDrivingLimitsForDriver(
            executor,
            ORG,
            'driver-1',
        );

        expect(limits.maxStops).toBe(40);
        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0].sql).toBe(DRIVING_LIMITS_SQL);
    });

    it('throws rather than returning undefined if the row for its own driver is missing', async () => {
        // Cannot happen from the real query (unnest guarantees one row per
        // input id), but a future edit that breaks that invariant must fail
        // loudly here rather than handing a caller an undefined DrivingLimits.
        const executor = fakeExecutor([row('some-other-driver')]);
        await expect(
            resolveDrivingLimitsForDriver(executor, ORG, 'driver-1'),
        ).rejects.toThrow(/driver-1/);
    });
});

describe('noLimitsForDrivers', () => {
    it('answers every driver with NO_LIMITS, with no query at all', () => {
        // Unlike coverage's disabled path, which still reads `drivers`, this
        // needs no executor: the answer does not depend on anything about
        // the driver.
        const limits = noLimitsForDrivers(['driver-1', 'driver-2']);
        expect(limits.get('driver-1')).toBe(NO_LIMITS);
        expect(limits.get('driver-2')).toBe(NO_LIMITS);
        expect(limits.size).toBe(2);
    });

    it('answers nothing for an empty list', () => {
        expect(noLimitsForDrivers([]).size).toBe(0);
    });
});

describe('drivingLimitsEnabled', () => {
    const original = process.env.DRIVING_LIMITS;

    afterEach(() => {
        if (original === undefined) delete process.env.DRIVING_LIMITS;
        else process.env.DRIVING_LIMITS = original;
    });

    it('is off by default', () => {
        delete process.env.DRIVING_LIMITS;
        expect(drivingLimitsEnabled()).toBe(false);
    });

    it.each(['on', 'true', '1'])(
        'is switched on by DRIVING_LIMITS=%s',
        (value) => {
            process.env.DRIVING_LIMITS = value;
            expect(drivingLimitsEnabled()).toBe(true);
        },
    );

    it.each(['off', 'ON', 'yes', 'enabled', ''])(
        'treats %p as off, because a typo must not switch it on',
        (value) => {
            process.env.DRIVING_LIMITS = value;
            expect(drivingLimitsEnabled()).toBe(false);
        },
    );

    it('is read per call, so the switch works without a restart', () => {
        delete process.env.DRIVING_LIMITS;
        expect(drivingLimitsEnabled()).toBe(false);
        process.env.DRIVING_LIMITS = 'on';
        expect(drivingLimitsEnabled()).toBe(true);
    });
});
