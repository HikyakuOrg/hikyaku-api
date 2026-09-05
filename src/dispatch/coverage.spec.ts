import {
    allDriversAsFloaters,
    allDriversAsFloatersForPoint,
    applyFloaterRule,
    coverageOutcomeFor,
    COVERAGE_OUTCOMES,
    coveringDriversForPoint,
    coveringDriversForPoints,
    COVERING_DRIVERS_SQL,
    ELIGIBLE_DRIVERS_SQL,
    isPlausibleLonLat,
    parseCoverageRows,
    serviceAreaMatchingEnabled,
    type CoveragePoint,
    type CoverageQueryExecutor,
} from './coverage';

/**
 * Everything here runs with NO DATABASE.
 *
 * The geometry itself (does this point fall inside this polygon, is a point on a
 * shared boundary covered, does a soft-deleted area drop out) is PostGIS's
 * answer, not this module's, and faking it would only test the fake. Those cases
 * live in test/coverage.e2e-spec.ts against a real database. What is testable
 * here is everything around the geometry: the floater rule, the coordinate
 * guard, the row shape checking, and the assembly of rows into the per-point
 * answer. That is the same division insertion.ts draws.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const WAREHOUSE = '00000000-0000-4000-8000-000000000002';

const QUERY = { organisationId: ORG, warehouseId: WAREHOUSE };

/** A point somewhere in Singapore. Never actually tested against a polygon. */
const POINT: CoveragePoint = { lon: 103.8198, lat: 1.3521 };

/**
 * An executor that hands back a canned result and records what it was asked.
 * Typed through the same interface the production code takes, so a change to
 * that seam breaks this file rather than silently bypassing it.
 */
function fakeExecutor(rows: unknown): CoverageQueryExecutor & {
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

function floaterRow(driverId: string) {
    return { point_index: null, driver_id: driverId, is_floater: true };
}

function coverRow(pointIndex: number, driverId: string) {
    return { point_index: pointIndex, driver_id: driverId, is_floater: false };
}

describe('the floater rule', () => {
    it('gives a driver with no service areas every point', () => {
        const coverage = applyFloaterRule(3, ['driver-a'], new Map());

        expect(coverage).toHaveLength(3);
        for (const point of coverage) {
            expect(point.floaterDriverIds).toEqual(['driver-a']);
            expect(point.explicitDriverIds).toEqual([]);
            expect(point.driverIds).toEqual(['driver-a']);
        }
    });

    it('keeps floaters and explicit coverage distinguishable', () => {
        // The diagnostic endpoint has to be able to say WHY a driver is
        // eligible, so the union must not be the only thing that survives.
        const coverage = applyFloaterRule(
            1,
            ['driver-floater'],
            new Map([[0, ['driver-explicit']]]),
        );

        expect(coverage[0].explicitDriverIds).toEqual(['driver-explicit']);
        expect(coverage[0].floaterDriverIds).toEqual(['driver-floater']);
        expect(coverage[0].driverIds).toEqual([
            'driver-explicit',
            'driver-floater',
        ]);
    });

    it('leaves a point nobody covers empty when there are no floaters', () => {
        const coverage = applyFloaterRule(2, [], new Map([[0, ['driver-a']]]));

        expect(coverage[0].driverIds).toEqual(['driver-a']);
        expect(coverage[1].driverIds).toEqual([]);
    });

    it('returns both drivers when two overlapping areas cover one point', () => {
        // Overlap is a legitimate configuration, not an error. Nothing in the
        // schema forbids it and nothing here collapses it to one answer.
        const coverage = applyFloaterRule(
            1,
            [],
            new Map([[0, ['driver-b', 'driver-a']]]),
        );

        expect(coverage[0].driverIds).toEqual(['driver-a', 'driver-b']);
    });

    it('deduplicates a driver reached through two areas covering one point', () => {
        const coverage = applyFloaterRule(
            1,
            [],
            new Map([[0, ['driver-a', 'driver-a']]]),
        );

        expect(coverage[0].explicitDriverIds).toEqual(['driver-a']);
        expect(coverage[0].driverIds).toEqual(['driver-a']);
    });

    it('sorts every list, so two runs over the same data agree exactly', () => {
        const coverage = applyFloaterRule(
            1,
            ['driver-z', 'driver-m'],
            new Map([[0, ['driver-c', 'driver-a']]]),
        );

        expect(coverage[0].floaterDriverIds).toEqual(['driver-m', 'driver-z']);
        expect(coverage[0].explicitDriverIds).toEqual(['driver-a', 'driver-c']);
        expect(coverage[0].driverIds).toEqual([
            'driver-a',
            'driver-c',
            'driver-m',
            'driver-z',
        ]);
    });

    it('returns one entry per point, in order, even with no coverage at all', () => {
        const coverage = applyFloaterRule(4, [], new Map());

        expect(coverage.map((c) => c.pointIndex)).toEqual([0, 1, 2, 3]);
    });

    it('returns nothing for no points', () => {
        expect(applyFloaterRule(0, ['driver-a'], new Map())).toEqual([]);
    });

    it('ignores coverage keyed to a point index outside the batch', () => {
        const coverage = applyFloaterRule(1, [], new Map([[7, ['driver-a']]]));

        expect(coverage).toHaveLength(1);
        expect(coverage[0].driverIds).toEqual([]);
    });
});

describe('isPlausibleLonLat', () => {
    it('accepts a real address', () => {
        expect(isPlausibleLonLat(103.8198, 1.3521)).toBe(true);
    });

    it('accepts the extremes of the coordinate ranges', () => {
        expect(isPlausibleLonLat(-180, -90)).toBe(true);
        expect(isPlausibleLonLat(180, 90)).toBe(true);
        expect(isPlausibleLonLat(0, 0)).toBe(true);
    });

    it('rejects the lon/lat swap', () => {
        // (103.8, 1.35) swapped is a latitude that does not exist. Same class of
        // bug service_areas_geometry_extent_chk catches on the polygon side.
        expect(isPlausibleLonLat(1.3521, 103.8198)).toBe(false);
    });

    it('rejects NaN and Infinity, which is what Number(null) upstream produces', () => {
        expect(isPlausibleLonLat(Number.NaN, 1.35)).toBe(false);
        expect(isPlausibleLonLat(103.8, Number.NaN)).toBe(false);
        expect(isPlausibleLonLat(Number.POSITIVE_INFINITY, 1.35)).toBe(false);
    });

    it('rejects Web Mercator metres handed over unreprojected', () => {
        expect(isPlausibleLonLat(11555000, 150000)).toBe(false);
    });

    it('rejects a longitude wrapped past the antimeridian by a map copy', () => {
        expect(isPlausibleLonLat(200, 1.35)).toBe(false);
    });
});

describe('parseCoverageRows', () => {
    it('reads a floater row and a coverage row', () => {
        expect(
            parseCoverageRows([
                floaterRow('driver-a'),
                coverRow(2, 'driver-b'),
            ]),
        ).toEqual([
            { pointIndex: null, driverId: 'driver-a', isFloater: true },
            { pointIndex: 2, driverId: 'driver-b', isFloater: false },
        ]);
    });

    it('reads an empty result', () => {
        expect(parseCoverageRows([])).toEqual([]);
    });

    it('coerces a point_index handed back as text', () => {
        const [row] = parseCoverageRows([
            { point_index: '3', driver_id: 'driver-a', is_floater: false },
        ]);

        expect(row.pointIndex).toBe(3);
    });

    it('throws when the driver did not return an array', () => {
        expect(() => parseCoverageRows(undefined)).toThrow(TypeError);
        expect(() => parseCoverageRows({ rows: [] })).toThrow(
            /expected an array/,
        );
    });

    it('throws on a row that is not an object', () => {
        expect(() => parseCoverageRows(['driver-a'])).toThrow(
            /row 0 is not an object/,
        );
    });

    it('throws rather than dropping a row missing driver_id', () => {
        // Dropping it would show up as a driver quietly vanishing from a
        // dispatch decision, which is far harder to trace than a loud failure.
        expect(() =>
            parseCoverageRows([{ point_index: 0, is_floater: false }]),
        ).toThrow(/no driver_id/);
    });

    it('throws on a row missing is_floater', () => {
        expect(() =>
            parseCoverageRows([{ point_index: 0, driver_id: 'driver-a' }]),
        ).toThrow(/no is_floater/);
    });

    it('throws on a non-integer point_index', () => {
        expect(() =>
            parseCoverageRows([
                {
                    point_index: 'first',
                    driver_id: 'driver-a',
                    is_floater: false,
                },
            ]),
        ).toThrow(/non-integer point_index/);
    });
});

describe('coveringDriversForPoints', () => {
    it('does not touch the database for an empty batch', async () => {
        const executor = fakeExecutor([]);

        await expect(
            coveringDriversForPoints(executor, QUERY, []),
        ).resolves.toEqual([]);
        expect(executor.calls).toHaveLength(0);
    });

    it('sends org, warehouse and two parallel coordinate arrays', async () => {
        const executor = fakeExecutor([]);

        await coveringDriversForPoints(executor, QUERY, [
            { lon: 1, lat: 2 },
            { lon: 3, lat: 4 },
        ]);

        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0].parameters).toEqual([
            ORG,
            WAREHOUSE,
            [1, 3],
            [2, 4],
        ]);
    });

    it('resolves a whole batch in one round trip', async () => {
        const executor = fakeExecutor([]);
        const points = Array.from({ length: 500 }, (_, i) => ({
            lon: 103.8 + i / 10000,
            lat: 1.35 + i / 10000,
        }));

        const coverage = await coveringDriversForPoints(
            executor,
            QUERY,
            points,
        );

        // The point of the batch form: assignMany() is sequential over N
        // packages and must not become N extra queries.
        expect(executor.calls).toHaveLength(1);
        expect(coverage).toHaveLength(500);
    });

    it('maps rows onto the points they belong to, and merges floaters into all', async () => {
        const executor = fakeExecutor([
            floaterRow('driver-float'),
            coverRow(0, 'driver-north'),
            coverRow(2, 'driver-south'),
        ]);

        const coverage = await coveringDriversForPoints(executor, QUERY, [
            { lon: 1, lat: 1 },
            { lon: 2, lat: 2 },
            { lon: 3, lat: 3 },
        ]);

        expect(coverage[0].driverIds).toEqual(['driver-float', 'driver-north']);
        expect(coverage[1].driverIds).toEqual(['driver-float']);
        expect(coverage[1].explicitDriverIds).toEqual([]);
        expect(coverage[2].driverIds).toEqual(['driver-float', 'driver-south']);
    });

    it('throws on an implausible coordinate instead of reporting nobody covers it', async () => {
        const executor = fakeExecutor([]);

        await expect(
            coveringDriversForPoints(executor, QUERY, [
                POINT,
                { lon: Number.NaN, lat: 1.35 },
            ]),
        ).rejects.toThrow(RangeError);
        expect(executor.calls).toHaveLength(0);
    });

    it('names the offending point in the error', async () => {
        const executor = fakeExecutor([]);

        await expect(
            coveringDriversForPoints(executor, QUERY, [
                POINT,
                POINT,
                { lon: 999, lat: 0 },
            ]),
        ).rejects.toThrow(/point 2/);
    });

    it('ignores a coverage row with no point index rather than blaming point 0', async () => {
        const executor = fakeExecutor([
            { point_index: null, driver_id: 'driver-a', is_floater: false },
        ]);

        const coverage = await coveringDriversForPoints(executor, QUERY, [
            POINT,
        ]);

        expect(coverage[0].driverIds).toEqual([]);
    });
});

describe('coveringDriversForPoint', () => {
    it('answers one point through the batch query, not a second one', async () => {
        const executor = fakeExecutor([coverRow(0, 'driver-a')]);

        const coverage = await coveringDriversForPoint(executor, QUERY, POINT);

        expect(coverage.pointIndex).toBe(0);
        expect(coverage.driverIds).toEqual(['driver-a']);
        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0].sql).toBe(COVERING_DRIVERS_SQL);
    });
});

/**
 * Guards on the SQL text itself.
 *
 * These are cheap and they catch the two edits most likely to be made by
 * somebody tidying the query up without reading why it is shaped that way. Both
 * would still return plausible-looking answers, which is exactly what makes them
 * worth a test rather than a comment alone.
 */
describe('the coverage query text', () => {
    it('uses ST_Covers, so a point on a shared boundary is covered', () => {
        expect(COVERING_DRIVERS_SQL).toContain('extensions.st_covers(');
        expect(COVERING_DRIVERS_SQL).not.toContain('st_contains');
    });

    it('filters soft-deleted service areas, which RLS will not do for it', () => {
        expect(COVERING_DRIVERS_SQL).toContain('sa.is_deleted      = false');
    });

    it('keeps the indexed geometry column bare inside the bbox operator', () => {
        // Wrapping it in st_setsrid here is what silently costs the GIST index.
        expect(COVERING_DRIVERS_SQL).toContain(
            'sa.geometry OPERATOR(extensions.&&) pts.geom',
        );
    });

    it('sets an explicit SRID on the point it builds', () => {
        expect(COVERING_DRIVERS_SQL).toContain(
            'extensions.st_setsrid(extensions.st_makepoint(',
        );
    });

    it('scopes both drivers and service areas to the organisation', () => {
        expect(COVERING_DRIVERS_SQL).toContain('d.organisation_id = $1::uuid');
        expect(COVERING_DRIVERS_SQL).toContain('sa.organisation_id = $1::uuid');
    });
});

describe('the disabled answer', () => {
    it('names no territory table at all', () => {
        // The kill switch's whole claim, checked against the SQL text rather
        // than against a mock that could be answering anything.
        expect(ELIGIBLE_DRIVERS_SQL).not.toContain('service_areas');
        expect(ELIGIBLE_DRIVERS_SQL).not.toContain('driver_service_area');
        expect(ELIGIBLE_DRIVERS_SQL).toContain('FROM drivers d');
    });

    it('narrows to the same drivers the real query would have considered', () => {
        // Both are built from ELIGIBLE_DRIVERS_CTE, so a change to who counts
        // as eligible cannot apply to one branch of the switch and not the
        // other.
        expect(ELIGIBLE_DRIVERS_SQL).toContain('d.organisation_id = $1::uuid');
        expect(ELIGIBLE_DRIVERS_SQL).toContain('d.warehouse_id    = $2::uuid');
    });

    it('makes every eligible driver a floater for every point', async () => {
        const executor = fakeExecutor([
            floaterRow('driver-b'),
            floaterRow('driver-a'),
        ]);

        const coverage = await allDriversAsFloaters(executor, QUERY, 2);

        expect(coverage).toHaveLength(2);
        for (const point of coverage) {
            expect(point.explicitDriverIds).toEqual([]);
            expect(point.floaterDriverIds).toEqual(['driver-a', 'driver-b']);
            expect(point.driverIds).toEqual(['driver-a', 'driver-b']);
        }
    });

    it('is byte-identical to the real answer for an empty link table', async () => {
        // The equivalence the whole kill switch rests on. An empty
        // driver_service_area makes the real query return exactly these
        // floater rows, so off and "on with nothing drawn" must agree.
        const rows = [floaterRow('driver-a'), floaterRow('driver-b')];

        const disabled = await allDriversAsFloaters(
            fakeExecutor(rows),
            QUERY,
            1,
        );
        const real = await coveringDriversForPoints(fakeExecutor(rows), QUERY, [
            POINT,
        ]);

        expect(disabled).toEqual(real);
    });

    it('takes ONE round trip whatever the batch size', async () => {
        const executor = fakeExecutor([floaterRow('driver-a')]);
        await allDriversAsFloaters(executor, QUERY, 500);
        expect(executor.calls).toHaveLength(1);
    });

    it('never touches the database for an empty batch', async () => {
        const executor = fakeExecutor([]);
        expect(await allDriversAsFloaters(executor, QUERY, 0)).toEqual([]);
        expect(executor.calls).toHaveLength(0);
    });

    it('answers a single point through the batch form, not a second query', async () => {
        const executor = fakeExecutor([floaterRow('driver-a')]);

        const coverage = await allDriversAsFloatersForPoint(executor, QUERY);

        expect(coverage.driverIds).toEqual(['driver-a']);
        expect(executor.calls).toHaveLength(1);
    });

    it('does not ask about the point, because the answer does not depend on it', async () => {
        const executor = fakeExecutor([floaterRow('driver-a')]);
        await allDriversAsFloatersForPoint(executor, QUERY);
        expect(executor.calls[0].parameters).toEqual([ORG, WAREHOUSE]);
    });
});

describe('serviceAreaMatchingEnabled', () => {
    const original = process.env.SERVICE_AREA_MATCHING;
    afterEach(() => {
        if (original === undefined) delete process.env.SERVICE_AREA_MATCHING;
        else process.env.SERVICE_AREA_MATCHING = original;
    });

    it('is off when nothing is set', () => {
        delete process.env.SERVICE_AREA_MATCHING;
        expect(serviceAreaMatchingEnabled()).toBe(false);
    });

    it.each(['on', 'true', '1'])('is on for %p', (value) => {
        process.env.SERVICE_AREA_MATCHING = value;
        expect(serviceAreaMatchingEnabled()).toBe(true);
    });

    it.each(['off', 'ON', 'True', 'yes', ''])(
        'is off for %p, so a typo cannot switch it on',
        (value) => {
            process.env.SERVICE_AREA_MATCHING = value;
            expect(serviceAreaMatchingEnabled()).toBe(false);
        },
    );
});

describe('coverageOutcomeFor', () => {
    const coverage = applyFloaterRule(
        1,
        ['floater-1'],
        new Map([[0, ['explicit-1']]]),
    )[0];

    it('reports `disabled` before it looks at anything else', () => {
        // Off means no question was asked. Reporting the synthesized
        // all-floater answer as `floater` would let an organisation the feature
        // was never switched on for report a perfect coverage rate.
        expect(coverageOutcomeFor(false, coverage, 'explicit-1')).toBe(
            'disabled',
        );
        expect(coverageOutcomeFor(false, coverage, 'nobody')).toBe('disabled');
    });

    it('separates a territory match from a driver who has no territories', () => {
        expect(coverageOutcomeFor(true, coverage, 'explicit-1')).toBe(
            'covered',
        );
        expect(coverageOutcomeFor(true, coverage, 'floater-1')).toBe('floater');
    });

    it('says which kind of fallback it was', () => {
        // "Somebody covers it but had no room" and "nobody covers it" are
        // different problems with different fixes, and one value for both would
        // throw away the bit that says which.
        expect(coverageOutcomeFor(true, coverage, 'someone-else')).toBe(
            'fallback_no_covering_capacity',
        );

        const uncovered = applyFloaterRule(1, [], new Map())[0];
        expect(coverageOutcomeFor(true, uncovered, 'someone-else')).toBe(
            'fallback_no_covering_driver',
        );
    });

    it('treats a shift with no driver as a fallback, never as covered', () => {
        expect(coverageOutcomeFor(true, coverage, null)).toBe(
            'fallback_no_covering_capacity',
        );
    });

    it('only ever returns a value the column will accept', () => {
        const produced = [
            coverageOutcomeFor(false, coverage, 'explicit-1'),
            coverageOutcomeFor(true, coverage, 'explicit-1'),
            coverageOutcomeFor(true, coverage, 'floater-1'),
            coverageOutcomeFor(true, coverage, 'someone-else'),
            coverageOutcomeFor(
                true,
                applyFloaterRule(1, [], new Map())[0],
                'x',
            ),
        ];
        for (const outcome of produced) {
            expect(COVERAGE_OUTCOMES).toContain(outcome);
        }
        // Every value is reachable, so none of them is dead weight in the
        // CHECK constraint or an unexplained gap in the summary.
        expect(new Set(produced).size).toBe(COVERAGE_OUTCOMES.length);
    });
});
