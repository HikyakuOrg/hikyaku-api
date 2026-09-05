import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
    CoverageDiagnosticsService,
    explain,
    explainSummary,
    parseRequest,
    parseSummaryDays,
    resolveAssignment,
} from './coverage-diagnostics.service';
import { COVERING_AREAS_SQL, COVERING_DRIVERS_SQL } from './coverage';

/**
 * The diagnostic endpoint, without a database.
 *
 * The half that needs live PostGIS (does this point fall inside this polygon, is
 * a boundary point covered, does a soft-deleted territory drop out, does a
 * cross-tenant probe come back empty against the real service_role connection)
 * is in test/coverage-diagnostics.e2e-spec.ts. What is checked here is
 * everything that is decided in TypeScript: which request forms are accepted,
 * how the answer is assembled, what is org-scoped, and, most importantly, that
 * the containment question is delegated to coverage.ts rather than answered
 * again here.
 */

// Wrapped rather than replaced: the real implementations still run, so these
// tests exercise the actual parsing and floater merging, while the spies can
// still prove the service went through coverage.ts to get its answer.
jest.mock('./coverage', () => {
    const actual = jest.requireActual('./coverage');
    return {
        ...actual,
        coveringDriversForPoint: jest.fn(actual.coveringDriversForPoint),
        coveringAreasForPoint: jest.fn(actual.coveringAreasForPoint),
    };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const coverage = require('./coverage') as {
    coveringDriversForPoint: jest.Mock;
    coveringAreasForPoint: jest.Mock;
};

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const WAREHOUSE = '33333333-3333-4333-8333-333333333333';
const OTHER_WAREHOUSE = '44444444-4444-4444-8444-444444444444';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const AREA = '66666666-6666-4666-8666-666666666666';
const SHIFT = '77777777-7777-4777-8777-777777777777';

const DRIVER_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const DRIVER_B = 'bbbbbbbb-0000-4000-8000-000000000000';

/** What the fake Postgres contains for one test. */
interface DbState {
    /** null means "no such package in this organisation". */
    package?: Record<string, unknown> | null;
    warehouses?: { id: string }[];
    /** Rows COVERING_DRIVERS_SQL answers with. */
    coverRows?: Record<string, unknown>[];
    /** Rows COVERING_AREAS_SQL answers with. */
    areaRows?: Record<string, unknown>[];
    areaDetails?: Record<string, unknown>[];
    organisationAreaCount?: number;
    /** Rows the summary's GROUP BY over package_assignment answers with. */
    outcomeCounts?: Record<string, unknown>[];
    /** Rows the summary's fallback sample answers with. */
    fallbackRows?: Record<string, unknown>[];
}

interface Call {
    sql: string;
    params: unknown[];
}

/**
 * A stand-in Postgres, matching on a distinctive fragment of each statement.
 *
 * The two coverage statements are matched by identity against the constants
 * coverage.ts exports, not by fragment: if this service ever grew its own
 * containment SQL, the fake would not recognise it and the tests would fail
 * rather than quietly pass on a second implementation.
 */
function fakeDataSource(state: DbState): {
    dataSource: DataSource;
    calls: Call[];
} {
    const calls: Call[] = [];

    const query = (sql: string, params: unknown[] = []): Promise<unknown> => {
        calls.push({ sql, params });

        if (sql === COVERING_DRIVERS_SQL) {
            return Promise.resolve(state.coverRows ?? []);
        }
        if (sql === COVERING_AREAS_SQL) {
            return Promise.resolve(state.areaRows ?? []);
        }
        if (sql.includes('FROM packages p')) {
            return Promise.resolve(
                state.package === null || state.package === undefined
                    ? []
                    : [state.package],
            );
        }
        if (sql.includes('FROM warehouse')) {
            return Promise.resolve(state.warehouses ?? [{ id: WAREHOUSE }]);
        }
        if (sql.includes('driver_service_area dsa')) {
            return Promise.resolve(state.areaDetails ?? []);
        }
        if (sql.includes('FROM service_areas')) {
            return Promise.resolve([
                { count: state.organisationAreaCount ?? 0 },
            ]);
        }
        // The two summary reads. Matched on package_assignment rather than on
        // `packages`, which they only join to for the organisation predicate.
        if (sql.includes('FROM package_assignment pa')) {
            return Promise.resolve(
                sql.includes('GROUP BY')
                    ? (state.outcomeCounts ?? [])
                    : (state.fallbackRows ?? []),
            );
        }
        throw new Error(`Unexpected statement: ${sql}`);
    };

    return {
        dataSource: { query } as unknown as DataSource,
        calls,
    };
}

function coverRow(
    pointIndex: number | null,
    driverId: string,
    isFloater = false,
): Record<string, unknown> {
    return {
        point_index: pointIndex,
        driver_id: driverId,
        is_floater: isFloater,
    };
}

function areaRow(id: string, name: string): Record<string, unknown> {
    return { point_index: 0, service_area_id: id, service_area_name: name };
}

const GEOCODED_PACKAGE = {
    id: PACKAGE,
    tracking_number: 'HK-0001',
    warehouse_id: WAREHOUSE,
    optimisation_id: null,
    lon: 103.85,
    lat: 1.29,
    driver_id: null,
    shift_status: null,
    recorded_outcome: null,
};

function service(state: DbState): {
    subject: CoverageDiagnosticsService;
    calls: Call[];
} {
    const { dataSource, calls } = fakeDataSource(state);
    return { subject: new CoverageDiagnosticsService(dataSource), calls };
}

beforeEach(() => {
    coverage.coveringDriversForPoint.mockClear();
    coverage.coveringAreasForPoint.mockClear();
});

// ── The guarantee the endpoint exists for ────────────────────────────────────

describe('one containment predicate, not two', () => {
    it('answers through coverage.ts rather than its own query', async () => {
        const { subject, calls } = service({
            package: GEOCODED_PACKAGE,
            coverRows: [coverRow(0, DRIVER_A)],
            areaRows: [areaRow(AREA, 'Downtown')],
            areaDetails: [{ id: AREA, driver_count: 1, geometry: null }],
        });

        await subject.explain(ORG, { packageId: PACKAGE });

        expect(coverage.coveringDriversForPoint).toHaveBeenCalledTimes(1);
        expect(coverage.coveringAreasForPoint).toHaveBeenCalledTimes(1);

        // Both were asked about the point the package resolved to, at the
        // package's own warehouse, in the caller's organisation.
        for (const spy of [
            coverage.coveringDriversForPoint,
            coverage.coveringAreasForPoint,
        ]) {
            const [, query, point] = spy.mock.calls[0] as [
                unknown,
                { organisationId: string; warehouseId: string },
                { lon: number; lat: number },
            ];
            expect(query).toEqual({
                organisationId: ORG,
                warehouseId: WAREHOUSE,
            });
            expect(point).toEqual({ lon: 103.85, lat: 1.29 });
        }

        // And the SQL that actually reached the database is the module's own
        // constant, so the two cannot drift apart without this failing.
        const statements = calls.map((call) => call.sql);
        expect(statements).toContain(COVERING_DRIVERS_SQL);
        expect(statements).toContain(COVERING_AREAS_SQL);
    });

    it('writes no containment test of its own', () => {
        // Cheap, and it catches the one edit most likely to be made by somebody
        // adding a field to the response without noticing why the query lives
        // in coverage.ts: a hand-rolled ST_Covers here would answer plausibly
        // and disagree with dispatch under exactly the cases that matter.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const source: string = require('fs').readFileSync(
            require.resolve('./coverage-diagnostics.service'),
            'utf8',
        );
        // Matched with the opening bracket so the prose in this file's own
        // header, which names both predicates to say it does not use them, is
        // not what trips the assertion.
        expect(source.toLowerCase()).not.toContain('st_covers(');
        expect(source.toLowerCase()).not.toContain('st_contains(');
        expect(source).not.toContain('OPERATOR(extensions.&&)');
    });
});

// ── Request forms ────────────────────────────────────────────────────────────

describe('parseRequest', () => {
    it('accepts the package form', () => {
        expect(parseRequest({ packageId: PACKAGE })).toEqual({
            form: 'package',
            packageId: PACKAGE,
            includeGeometry: false,
        });
    });

    it('accepts the coordinate form', () => {
        expect(parseRequest({ lon: '103.85', lat: '1.29' })).toEqual({
            form: 'coordinates',
            point: { lon: 103.85, lat: 1.29 },
            warehouseId: null,
            includeGeometry: false,
        });
    });

    it('rejects both forms at once', () => {
        expect(() =>
            parseRequest({ packageId: PACKAGE, lon: '103.85', lat: '1.29' }),
        ).toThrow(BadRequestException);
    });

    it('rejects neither form', () => {
        expect(() => parseRequest({})).toThrow(BadRequestException);
    });

    it('treats blank values as absent', () => {
        expect(() => parseRequest({ packageId: '   ', lon: '' })).toThrow(
            /Pass packageId, or lon and lat/,
        );
    });

    it('rejects a longitude with no latitude', () => {
        expect(() => parseRequest({ lon: '103.85' })).toThrow(
            /lon and lat must be given together/,
        );
    });

    it('rejects a latitude with no longitude', () => {
        expect(() => parseRequest({ lat: '1.29' })).toThrow(
            /lon and lat must be given together/,
        );
    });

    it.each([
        ['a swapped pair', '1.29', '103.85'],
        ['a longitude past 180', '181', '0'],
        ['a longitude past -180', '-181', '0'],
        ['a latitude past 90', '0', '91'],
        ['a latitude past -90', '0', '-91'],
        ['text', 'downtown', '1.29'],
    ])('rejects %s', (_label, lon, lat) => {
        expect(() => parseRequest({ lon, lat })).toThrow(
            /not a usable coordinate/,
        );
    });

    it('accepts the extremes of both ranges', () => {
        expect(parseRequest({ lon: '180', lat: '90' })).toMatchObject({
            point: { lon: 180, lat: 90 },
        });
        expect(parseRequest({ lon: '-180', lat: '-90' })).toMatchObject({
            point: { lon: -180, lat: -90 },
        });
    });

    it('refuses a warehouseId alongside a packageId', () => {
        expect(() =>
            parseRequest({ packageId: PACKAGE, warehouseId: WAREHOUSE }),
        ).toThrow(/already names the warehouse/);
    });

    it.each([
        ['true', true],
        ['1', true],
        ['false', false],
        ['0', false],
    ])('reads includeGeometry=%s as %s', (value, expected) => {
        expect(
            parseRequest({ packageId: PACKAGE, includeGeometry: value }),
        ).toMatchObject({ includeGeometry: expected });
    });

    it('rejects an includeGeometry it does not recognise', () => {
        expect(() =>
            parseRequest({ packageId: PACKAGE, includeGeometry: 'yes' }),
        ).toThrow(/includeGeometry must be true or false/);
    });
});

// ── The package form ─────────────────────────────────────────────────────────

describe('the package form', () => {
    it('echoes the point, the areas and the drivers', async () => {
        const { subject } = service({
            package: GEOCODED_PACKAGE,
            coverRows: [coverRow(0, DRIVER_A), coverRow(null, DRIVER_B, true)],
            areaRows: [areaRow(AREA, 'Downtown')],
            areaDetails: [{ id: AREA, driver_count: 1, geometry: null }],
            organisationAreaCount: 3,
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.resolution).toBe('evaluated');
        expect(result.point).toEqual({ lon: 103.85, lat: 1.29 });
        expect(result.packageId).toBe(PACKAGE);
        expect(result.trackingNumber).toBe('HK-0001');
        expect(result.warehouseId).toBe(WAREHOUSE);
        expect(result.anyAreaCovers).toBe(true);
        expect(result.organisationAreaCount).toBe(3);
        expect(result.areas).toEqual([
            { id: AREA, name: 'Downtown', driverCount: 1 },
        ]);
        expect(result.drivers).toEqual([
            { driverId: DRIVER_A, matchedBy: 'explicit' },
            { driverId: DRIVER_B, matchedBy: 'floater' },
        ]);
    });

    it('reports an unassigned package as unassigned', async () => {
        const { subject } = service({
            package: GEOCODED_PACKAGE,
            coverRows: [coverRow(0, DRIVER_A)],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment).toBeNull();
    });

    it('calls an assignment to a covering driver a covered match', async () => {
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                optimisation_id: SHIFT,
                driver_id: DRIVER_A,
                shift_status: 'planned',
            },
            coverRows: [coverRow(0, DRIVER_A)],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment).toEqual({
            shiftId: SHIFT,
            driverId: DRIVER_A,
            shiftStatus: 'planned',
            matchedBy: 'explicit',
            covered: true,
            recordedOutcome: null,
        });
    });

    it('reports what dispatch recorded, not only what it recomputes', async () => {
        // The two are different questions. `matchedBy` is the map as it stands
        // now; `recordedOutcome` is the decision that was actually taken. Every
        // input to that decision is read fresh on every assignment, so once a
        // territory is redrawn the recorded value is the only surviving record
        // of it.
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                optimisation_id: SHIFT,
                driver_id: DRIVER_A,
                shift_status: 'planned',
                recorded_outcome: 'covered',
            },
            // The territory that selected DRIVER_A has since been redrawn, so
            // recomputing today says the package should never have gone there.
            coverRows: [],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment).toMatchObject({
            matchedBy: 'not_covering',
            recordedOutcome: 'covered',
        });
    });

    it('reports a value it does not recognise as no recorded decision', async () => {
        // The column and this build having drifted, most likely mid-deploy.
        // Null already means "nothing recorded", which is a safer thing for a
        // client to render than a string its enum does not contain.
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                optimisation_id: SHIFT,
                driver_id: DRIVER_A,
                shift_status: 'planned',
                recorded_outcome: 'something_from_the_future',
            },
            coverRows: [coverRow(0, DRIVER_A)],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment?.recordedOutcome).toBeNull();
    });

    it('carries the recorded outcome through even when coverage was never evaluated', async () => {
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                lon: null,
                lat: null,
                optimisation_id: SHIFT,
                driver_id: DRIVER_A,
                shift_status: 'planned',
                recorded_outcome: 'disabled',
            },
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.resolution).toBe('package_not_geocoded');
        expect(result.assignment?.recordedOutcome).toBe('disabled');
    });

    it('distinguishes a floater assignment from a territory match', async () => {
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                optimisation_id: SHIFT,
                driver_id: DRIVER_B,
                shift_status: 'planned',
            },
            coverRows: [coverRow(null, DRIVER_B, true)],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment).toMatchObject({
            matchedBy: 'floater',
            covered: true,
        });
        expect(result.explanation).toContain('floater');
    });

    it('flags an assignment coverage does not explain', async () => {
        // The comparison the endpoint exists for: the package went somewhere no
        // territory selects, and the driver is not a floater either.
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                optimisation_id: SHIFT,
                driver_id: DRIVER_B,
                shift_status: 'dispatched',
            },
            coverRows: [coverRow(0, DRIVER_A)],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment).toMatchObject({
            driverId: DRIVER_B,
            matchedBy: 'not_covering',
            covered: false,
        });
        expect(result.explanation).toContain('does not cover this point');
    });

    it('answers a package with no geocode instead of erroring', async () => {
        const { subject, calls } = service({
            package: { ...GEOCODED_PACKAGE, lon: null, lat: null },
            organisationAreaCount: 2,
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.resolution).toBe('package_not_geocoded');
        expect(result.point).toBeNull();
        expect(result.explanation).toContain('no delivery coordinates');
        // Not an empty coverage answer, which would read as "geocoded and
        // genuinely uncovered" and send somebody to redraw a territory.
        expect(result.drivers).toEqual([]);
        expect(result.areas).toEqual([]);
        expect(result.anyAreaCovers).toBe(false);
        expect(calls.map((c) => c.sql)).not.toContain(COVERING_DRIVERS_SQL);
        expect(coverage.coveringDriversForPoint).not.toHaveBeenCalled();
    });

    it('answers a package with no warehouse instead of erroring', async () => {
        const { subject } = service({
            package: { ...GEOCODED_PACKAGE, warehouse_id: null },
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.resolution).toBe('package_has_no_warehouse');
        // The point is still echoed: it is the half of the answer that exists.
        expect(result.point).toEqual({ lon: 103.85, lat: 1.29 });
        expect(coverage.coveringDriversForPoint).not.toHaveBeenCalled();
    });

    it('still reports the shift for a package with no geocode', async () => {
        const { subject } = service({
            package: {
                ...GEOCODED_PACKAGE,
                lon: null,
                lat: null,
                optimisation_id: SHIFT,
                driver_id: DRIVER_A,
                shift_status: 'planned',
            },
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.assignment).toMatchObject({
            shiftId: SHIFT,
            driverId: DRIVER_A,
            matchedBy: 'unassigned',
            covered: false,
        });
    });

    it('reports an unknown package as not found', async () => {
        const { subject } = service({ package: null });

        await expect(
            subject.explain(ORG, { packageId: PACKAGE }),
        ).rejects.toThrow(NotFoundException);
    });

    it('scopes the package lookup to the caller’s organisation', async () => {
        // The cross-tenant probe, at the statement level: the organisation is
        // the caller's, never anything from the query string. This process
        // bypasses RLS, so this predicate is the only thing standing between a
        // support tool and another tenant's packages.
        const { subject, calls } = service({ package: null });

        await expect(
            subject.explain(ORG, { packageId: PACKAGE }),
        ).rejects.toThrow(NotFoundException);

        const lookup = calls.find((call) =>
            call.sql.includes('FROM packages p'),
        );
        expect(lookup?.sql).toContain('p.organisation_id = $2::uuid');
        expect(lookup?.params).toEqual([PACKAGE, ORG]);
        expect(lookup?.params).not.toContain(OTHER_ORG);
    });
});

// ── The coordinate form ──────────────────────────────────────────────────────

describe('the coordinate form', () => {
    it('uses the organisation’s only warehouse when none is named', async () => {
        const { subject } = service({
            warehouses: [{ id: WAREHOUSE }],
            coverRows: [coverRow(null, DRIVER_A, true)],
        });

        const result = await subject.explain(ORG, {
            lon: '103.85',
            lat: '1.29',
        });

        expect(result.warehouseId).toBe(WAREHOUSE);
        expect(result.packageId).toBeNull();
        expect(result.trackingNumber).toBeNull();
        expect(result.assignment).toBeNull();
        expect(result.drivers).toEqual([
            { driverId: DRIVER_A, matchedBy: 'floater' },
        ]);
    });

    it('accepts a warehouse that belongs to the organisation', async () => {
        const { subject } = service({
            warehouses: [{ id: WAREHOUSE }, { id: OTHER_WAREHOUSE }],
        });

        const result = await subject.explain(ORG, {
            lon: '103.85',
            lat: '1.29',
            warehouseId: OTHER_WAREHOUSE,
        });

        expect(result.warehouseId).toBe(OTHER_WAREHOUSE);
    });

    it('reports a warehouse from another organisation as not found', async () => {
        // Not "forbidden", and not a confident "nobody covers this" either: a
        // cross-tenant id must read as unknown.
        const { subject, calls } = service({ warehouses: [{ id: WAREHOUSE }] });

        await expect(
            subject.explain(ORG, {
                lon: '103.85',
                lat: '1.29',
                warehouseId: OTHER_WAREHOUSE,
            }),
        ).rejects.toThrow(NotFoundException);

        const lookup = calls.find((call) =>
            call.sql.includes('FROM warehouse'),
        );
        expect(lookup?.params).toEqual([ORG]);
        expect(coverage.coveringDriversForPoint).not.toHaveBeenCalled();
    });

    it('asks which warehouse when the organisation has several', async () => {
        const { subject } = service({
            warehouses: [{ id: WAREHOUSE }, { id: OTHER_WAREHOUSE }],
        });

        await expect(
            subject.explain(ORG, { lon: '103.85', lat: '1.29' }),
        ).rejects.toThrow(/Pass warehouseId/);
    });

    it('says so when the organisation has no warehouses at all', async () => {
        const { subject } = service({ warehouses: [] });

        await expect(
            subject.explain(ORG, { lon: '103.85', lat: '1.29' }),
        ).rejects.toThrow(/no warehouses/);
    });
});

// ── Geometry stays opt-in ────────────────────────────────────────────────────

describe('geometry', () => {
    const withArea: DbState = {
        package: GEOCODED_PACKAGE,
        areaRows: [areaRow(AREA, 'Downtown')],
        areaDetails: [
            {
                id: AREA,
                driver_count: 2,
                geometry: '{"type":"MultiPolygon","coordinates":[]}',
            },
        ],
    };

    it('is left out by default', async () => {
        const { subject, calls } = service(withArea);

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.areas[0]).not.toHaveProperty('geometry');
        const detail = calls.find((call) =>
            call.sql.includes('AS driver_count'),
        );
        expect(detail?.params[3]).toBe(false);
    });

    it('is included when asked for', async () => {
        const { subject, calls } = service(withArea);

        const result = await subject.explain(ORG, {
            packageId: PACKAGE,
            includeGeometry: 'true',
        });

        expect(result.areas[0].geometry).toEqual({
            type: 'MultiPolygon',
            coordinates: [],
        });
        const detail = calls.find((call) =>
            call.sql.includes('AS driver_count'),
        );
        expect(detail?.params[3]).toBe(true);
    });

    it('does not fail the whole answer on unparseable geometry', async () => {
        const { subject } = service({
            ...withArea,
            areaDetails: [{ id: AREA, driver_count: 2, geometry: 'not json' }],
        });

        const result = await subject.explain(ORG, {
            packageId: PACKAGE,
            includeGeometry: 'true',
        });

        expect(result.areas[0].geometry).toBeNull();
        expect(result.areas[0].name).toBe('Downtown');
    });

    it('scopes the area lookup to the organisation and warehouse', async () => {
        const { subject, calls } = service(withArea);

        await subject.explain(ORG, { packageId: PACKAGE });

        const detail = calls.find((call) =>
            call.sql.includes('AS driver_count'),
        );
        expect(detail?.params).toEqual([[AREA], ORG, WAREHOUSE, false]);
    });

    it('reports a territory nobody at this warehouse is staffed on', async () => {
        const { subject } = service({
            ...withArea,
            areaDetails: [{ id: AREA, driver_count: 0, geometry: null }],
            coverRows: [],
        });

        const result = await subject.explain(ORG, { packageId: PACKAGE });

        expect(result.anyAreaCovers).toBe(true);
        expect(result.areas[0].driverCount).toBe(0);
        expect(result.drivers).toEqual([]);
    });
});

// ── The three states the boolean exists to separate ──────────────────────────

describe('explain', () => {
    const base = {
        resolution: 'evaluated' as const,
        areaCount: 0,
        organisationAreaCount: 0,
        explicitCount: 0,
        floaterCount: 0,
        assignment: null,
    };

    it('says nothing is configured when the organisation has no territories', () => {
        expect(explain({ ...base, floaterCount: 3 })).toContain(
            'No territories are configured',
        );
    });

    it('separates "no territory here" from "no territories at all"', () => {
        expect(explain({ ...base, organisationAreaCount: 5 })).toContain(
            'No territory covers this point, though the organisation has 5 live.',
        );
    });

    it('counts the territories that do cover the point', () => {
        expect(
            explain({ ...base, areaCount: 1, organisationAreaCount: 5 }),
        ).toContain('1 territory covers this point.');
        expect(
            explain({ ...base, areaCount: 2, organisationAreaCount: 5 }),
        ).toContain('2 territories cover this point.');
    });

    it('splits the driver count by why each driver matched', () => {
        expect(
            explain({ ...base, explicitCount: 2, floaterCount: 1 }),
        ).toContain('3 driver(s) cover it: 2 by territory, 1 as floaters');
    });

    it('says plainly when nobody covers the point', () => {
        expect(explain({ ...base, organisationAreaCount: 1 })).toContain(
            'No driver at this warehouse covers it.',
        );
    });

    it('explains a package that was never geocoded', () => {
        expect(
            explain({ ...base, resolution: 'package_not_geocoded' }),
        ).toContain('no delivery coordinates yet');
    });

    it('explains a package with no warehouse', () => {
        expect(
            explain({ ...base, resolution: 'package_has_no_warehouse' }),
        ).toContain('not attached to a warehouse');
    });
});

describe('resolveAssignment', () => {
    const assignment = {
        shiftId: SHIFT,
        driverId: DRIVER_A,
        shiftStatus: 'planned',
        matchedBy: 'unassigned' as const,
        covered: false,
    };

    it('is unassigned when no driver is on the shift', () => {
        expect(
            resolveAssignment({ ...assignment, driverId: null }, [], []),
        ).toMatchObject({ matchedBy: 'unassigned', covered: false });
    });

    it('prefers the explicit match when a driver is in both sets', () => {
        // Cannot happen through coverage.ts, which makes the two sets disjoint,
        // but the answer should be the more informative one either way.
        expect(
            resolveAssignment(assignment, [DRIVER_A], [DRIVER_A]),
        ).toMatchObject({ matchedBy: 'explicit' });
    });
});

// ── The rollout summary ──────────────────────────────────────────────────────

describe('parseSummaryDays', () => {
    it('defaults to a full weekly delivery cycle', () => {
        expect(parseSummaryDays(undefined)).toBe(7);
        expect(parseSummaryDays('  ')).toBe(7);
    });

    it('takes a whole number of days inside the range', () => {
        expect(parseSummaryDays('1')).toBe(1);
        expect(parseSummaryDays('30')).toBe(30);
    });

    it.each(['0', '31', '-1', '3.5', 'week', ''])(
        'refuses %p rather than clamping it',
        (value) => {
            // Clamping would hand back a number that means something other than
            // what the caller asked for, and a rollout decision is the wrong
            // place to discover that.
            if (value === '') {
                expect(parseSummaryDays(value)).toBe(7);
                return;
            }
            expect(() => parseSummaryDays(value)).toThrow(BadRequestException);
        },
    );
});

describe('explainSummary', () => {
    const base = {
        windowDays: 7,
        decisions: 100,
        coveredRate: 0.94,
        liveServiceAreaCount: 6,
        serviceAreaMatching: true,
    };

    it('leads with the rate', () => {
        expect(explainSummary(base)).toContain('94% of 100');
    });

    it('says an empty map is the correct answer, not a finished one', () => {
        // The single most misreadable state: 100% covered on an organisation
        // that has drawn nothing, entirely on floater matches.
        const text = explainSummary({
            ...base,
            coveredRate: 1,
            liveServiceAreaCount: 0,
        });
        expect(text).toContain('No territories are drawn');
        expect(text).toContain('correct answer, not a finished map');
    });

    it('says when the rate describes history rather than what is happening', () => {
        expect(
            explainSummary({ ...base, serviceAreaMatching: false }),
        ).toContain('currently switched off');
    });

    it('does not report an unmeasured organisation as a failure', () => {
        const text = explainSummary({
            ...base,
            decisions: 0,
            coveredRate: null,
        });
        expect(text).toContain('no coverage rate to report yet');
        expect(text).not.toContain('0%');
    });
});

describe('the coverage summary', () => {
    const original = process.env.SERVICE_AREA_MATCHING;
    afterEach(() => {
        if (original === undefined) delete process.env.SERVICE_AREA_MATCHING;
        else process.env.SERVICE_AREA_MATCHING = original;
    });

    const COUNTS = [
        { outcome: 'covered', count: 60 },
        { outcome: 'floater', count: 30 },
        { outcome: 'fallback_no_covering_capacity', count: 6 },
        { outcome: 'fallback_no_covering_driver', count: 4 },
    ];

    it('rates coverage over the decisions actually taken', async () => {
        const { subject } = service({
            outcomeCounts: COUNTS,
            organisationAreaCount: 6,
        });

        const summary = await subject.summary(ORG);

        expect(summary.totalAssigned).toBe(100);
        expect(summary.decisions).toBe(100);
        expect(summary.coveredRate).toBe(0.9);
        expect(summary.byOutcome).toEqual({
            covered: 60,
            floater: 30,
            fallbackNoCoveringCapacity: 6,
            fallbackNoCoveringDriver: 4,
            disabled: 0,
        });
    });

    it('leaves packages placed with the feature off out of the rate', async () => {
        // Otherwise an organisation the flag was never switched on for reports
        // a perfect score, which is exactly the number somebody would quote
        // when deciding whether it is safe to switch it on.
        const { subject } = service({
            outcomeCounts: [
                { outcome: 'disabled', count: 500 },
                { outcome: 'covered', count: 8 },
                { outcome: 'fallback_no_covering_driver', count: 2 },
            ],
        });

        const summary = await subject.summary(ORG);

        expect(summary.totalAssigned).toBe(510);
        expect(summary.decisions).toBe(10);
        expect(summary.coveredRate).toBe(0.8);
        expect(summary.byOutcome.disabled).toBe(500);
    });

    it('reports an unmeasured organisation as unknown, not as zero', async () => {
        const { subject } = service({ outcomeCounts: [] });
        const summary = await subject.summary(ORG);
        expect(summary.decisions).toBe(0);
        expect(summary.coveredRate).toBeNull();
    });

    it('carries the territory count needed to read the rate at all', async () => {
        const { subject } = service({
            outcomeCounts: [{ outcome: 'floater', count: 40 }],
            organisationAreaCount: 0,
        });

        const summary = await subject.summary(ORG);

        expect(summary.coveredRate).toBe(1);
        expect(summary.liveServiceAreaCount).toBe(0);
        expect(summary.explanation).toContain('No territories are drawn');
    });

    it('reports whether the feature is switched on for this process', async () => {
        process.env.SERVICE_AREA_MATCHING = 'on';
        const { subject } = service({ outcomeCounts: [] });
        expect((await subject.summary(ORG)).serviceAreaMatching).toBe(true);

        delete process.env.SERVICE_AREA_MATCHING;
        expect((await subject.summary(ORG)).serviceAreaMatching).toBe(false);
    });

    it('names the packages that fell back, which is the dispatcher’s question', async () => {
        const { subject } = service({
            outcomeCounts: COUNTS,
            fallbackRows: [
                {
                    package_id: PACKAGE,
                    tracking_number: 'HK-0001',
                    coverage_outcome: 'fallback_no_covering_driver',
                    driver_id: DRIVER_A,
                    optimisation_id: SHIFT,
                    created_at: '2026-09-01T09:00:00.000Z',
                },
            ],
        });

        const summary = await subject.summary(ORG);

        expect(summary.fallbacks).toEqual([
            {
                packageId: PACKAGE,
                trackingNumber: 'HK-0001',
                outcome: 'fallback_no_covering_driver',
                driverId: DRIVER_A,
                shiftId: SHIFT,
                assignedAt: '2026-09-01T09:00:00.000Z',
            },
        ]);
    });

    it('drops a sampled row whose outcome is not a fallback', async () => {
        // Belt and braces against the query and this file drifting apart:
        // a `covered` package in the fallback list would be reported to a
        // dispatcher as a routing failure that never happened.
        const { subject } = service({
            outcomeCounts: COUNTS,
            fallbackRows: [
                {
                    package_id: PACKAGE,
                    tracking_number: null,
                    coverage_outcome: 'covered',
                    driver_id: DRIVER_A,
                    optimisation_id: SHIFT,
                    created_at: '2026-09-01T09:00:00.000Z',
                },
            ],
        });

        expect((await subject.summary(ORG)).fallbacks).toEqual([]);
    });

    it('scopes every read to the caller’s organisation', async () => {
        // This process connects as service_role and bypasses RLS, so the
        // organisation predicate in each statement is the only thing keeping
        // one tenant's rollout numbers out of another's.
        const { subject, calls } = service({ outcomeCounts: COUNTS });

        await subject.summary(ORG, '14');

        const reads = calls.filter((call) =>
            call.sql.includes('FROM package_assignment pa'),
        );
        expect(reads).toHaveLength(2);
        for (const read of reads) {
            expect(read.sql).toMatch(/p\.organisation_id\s+= \$1::uuid/);
            expect(read.params[0]).toBe(ORG);
            expect(read.params[1]).toBe(14);
        }
    });

    it('counts only what automatic assignment placed', async () => {
        // A dispatcher's hand-pinned package took no coverage decision, and its
        // row carries no outcome. Counting it either way would be wrong.
        const { subject, calls } = service({ outcomeCounts: COUNTS });

        await subject.summary(ORG);

        const counts = calls.find(
            (call) =>
                call.sql.includes('FROM package_assignment pa') &&
                call.sql.includes('GROUP BY'),
        );
        expect(counts?.sql).toContain('pa.coverage_outcome IS NOT NULL');
    });
});
