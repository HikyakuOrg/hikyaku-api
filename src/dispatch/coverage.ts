/**
 * Which drivers cover a delivery point?
 *
 * One question, one implementation. Two things will call this: the Tier 1
 * assignment change (to narrow its candidate drivers before costing insertions)
 * and a coverage diagnostic endpoint (to tell a dispatcher why a package went
 * where it went). THEY MUST CALL THE SAME CODE. A diagnostic that quietly
 * disagrees with what dispatch actually did is worse than no diagnostic at all,
 * because it sends whoever is debugging an incident down the wrong path with
 * apparent authority. So there is exactly one predicate here, in one SQL string,
 * and the single-point entry point is a thin wrapper over the batch one rather
 * than a second copy of the query.
 *
 * Nothing calls it yet. This module is deliberately shipped inert.
 *
 * The split between this file and its future callers mirrors the split between
 * `insertion.ts` and `assignment.service.ts`: everything that can be decided
 * without a database is a pure function over plain objects, testable as a table
 * of inputs and expected outputs, and the I/O is one narrow, explicitly typed
 * seam. Read `insertion.ts`'s header for why that matters here.
 */

// ── The executor seam ────────────────────────────────────────────────────────

/**
 * The only thing this module needs from TypeORM.
 *
 * Both `DataSource` and `QueryRunner` satisfy it structurally, so a caller can
 * run coverage inside an existing transaction (the assignment path holds an
 * advisory lock and a query runner) or outside one (a diagnostic endpoint),
 * without this module importing or knowing about either. The return is
 * `unknown` rather than `any` on purpose: the pg driver's row shapes are not
 * checked by the compiler, so they are checked here instead, once, in
 * `parseCoverageRows`.
 */
export interface CoverageQueryExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

// ── Plain data ───────────────────────────────────────────────────────────────

/** A delivery point, in the same lon/lat order the rest of dispatch uses. */
export interface CoveragePoint {
    lon: number;
    lat: number;
}

export interface CoverageQuery {
    organisationId: string;
    /** Drivers are scoped to one warehouse, as everywhere else in dispatch. */
    warehouseId: string;
}

/**
 * Who covers one point.
 *
 * `explicitDriverIds` and `floaterDriverIds` are kept apart rather than merged,
 * because they are genuinely different states and the diagnostic endpoint has to
 * be able to show which one it is looking at. "Nobody has drawn a territory for
 * this driver" and "this driver's territory contains the address" both make the
 * driver eligible, but only one of them is a decision somebody made on purpose.
 *
 * Every list is sorted ascending and deduplicated, so two runs over the same
 * data produce byte-identical output and a test can assert on it directly.
 */
export interface PointCoverage {
    /** Index into the `points` array that was passed in. */
    pointIndex: number;
    /** Drivers covering this point through a service area that contains it. */
    explicitDriverIds: string[];
    /** Drivers covering it under the floater rule below. Same for every point. */
    floaterDriverIds: string[];
    /** The union of the two, which is what dispatch filters candidates by. */
    driverIds: string[];
}

/** One row as the SQL below returns it, after shape checking. */
interface CoverageRow {
    /** Null on a floater row, which is not tied to any one point. */
    pointIndex: number | null;
    driverId: string;
    isFloater: boolean;
}

// ── The floater rule ─────────────────────────────────────────────────────────

/**
 * THE FLOATER RULE: A DRIVER WITH NO SERVICE AREAS COVERS EVERYWHERE.
 *
 * Named, exported and given its own function so a future reader can find the
 * decision without reading the whole query. It is also written out in the table
 * comment on `driver_service_area` and in `DriverServiceArea`'s class doc, in
 * those same words, so grepping for "floater" finds all three.
 *
 * The rule is deliberately permissive. The strict reading, that a driver with no
 * areas covers nothing, is defensible in the abstract and catastrophic in
 * practice: on the morning this feature ships, every driver in every
 * organisation has zero coverage rows, so under the strict reading every driver
 * becomes ineligible for every package and every package defers. The permissive
 * reading makes an empty `driver_service_area` behave byte-identically to the
 * engine as it exists today, which is the requirement the whole feature was
 * built against, and it keeps degrading gracefully afterwards: a dispatcher who
 * staffs three of eight territories gets exactly what they configured, with the
 * other five drivers still able to take anything.
 *
 * The rule has two halves and both are load-bearing. The SQL half identifies
 * floaters, with a `NOT EXISTS` against the whole link table rather than against
 * the live areas only. That is on purpose: a driver whose only territory has
 * been soft-deleted is NOT a floater. They are a driver whose territory was
 * retired, and quietly promoting them to covering the entire metro because a
 * dispatcher retired one polygon would be a surprising and expensive
 * reinterpretation of that click. They cover nothing until somebody says
 * otherwise, which is visible and fixable, where silently covering everything is
 * neither. This function is the other half: it merges the floater set into every
 * point's answer.
 *
 * Pure, so it is unit tested with no database.
 *
 * @param pointCount           length of the caller's `points` array
 * @param floaterDriverIds     drivers with no rows at all in driver_service_area
 * @param explicitByPointIndex point index to drivers covering it through an area
 */
export function applyFloaterRule(
    pointCount: number,
    floaterDriverIds: readonly string[],
    explicitByPointIndex: ReadonlyMap<number, readonly string[]>,
): PointCoverage[] {
    const floaters = sortedUnique(floaterDriverIds);

    const coverage: PointCoverage[] = [];
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const explicit = sortedUnique(
            explicitByPointIndex.get(pointIndex) ?? [],
        );
        coverage.push({
            pointIndex,
            explicitDriverIds: explicit,
            floaterDriverIds: floaters,
            // A driver cannot be in both sets: being in the explicit set means
            // having at least one row in driver_service_area, which is exactly
            // what disqualifies them from the floater set. The union is
            // deduplicated anyway, because relying on that invariant to stay
            // true is not worth the four characters it saves.
            driverIds: sortedUnique([...explicit, ...floaters]),
        });
    }
    return coverage;
}

/** Ascending, deduplicated, new array. Determinism for tests and for logs. */
function sortedUnique(ids: readonly string[]): string[] {
    return [...new Set(ids)].sort();
}

// ── Input validation ─────────────────────────────────────────────────────────

/**
 * Is this a coordinate that could name somewhere on Earth?
 *
 * Rejects NaN and Infinity, which reach here whenever an upstream `Number(...)`
 * of a null column silently produced one, and coordinates outside the real
 * lon/lat ranges. That second half is the lon/lat swap in its most common form:
 * a Singapore address is around (103.8, 1.35), and swapped it is (1.35, 103.8),
 * which is not a latitude that exists. It is the same class of bug
 * service_areas_geometry_extent_chk guards on the polygon side, checked here on
 * the point side, where no constraint can reach.
 *
 * Silently returning "nobody covers this" for a broken coordinate would look
 * exactly like a correctly configured driver simply not covering an address, so
 * the caller throws on it instead. Pure.
 */
export function isPlausibleLonLat(lon: number, lat: number): boolean {
    return (
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        lon >= -180 &&
        lon <= 180 &&
        lat >= -90 &&
        lat <= 90
    );
}

// ── The query ────────────────────────────────────────────────────────────────

/**
 * $1 organisation id, $2 warehouse id, $3 longitudes, $4 latitudes.
 *
 * $3 and $4 are two parallel arrays rather than one array of composites, because
 * the pg driver serialises a plain `number[]` into a Postgres array literal
 * without any type registration, and a composite type would need one.
 *
 * ── WHY THIS SHAPE, AND NOT AN `EXISTS` PER DRIVER ──────────────────────────
 *
 * The obvious way to write this is to scan the eligible drivers and hang a
 * correlated `EXISTS (... ST_Covers ...)` off each one. That version is correct
 * and it cannot use the GIST index, for a reason worth spelling out because it
 * is not obvious from the SQL.
 *
 * PostGIS 3 does not implement `ST_Covers` as a SQL wrapper that spells out the
 * bounding-box test. It is a C function carrying a planner SUPPORT function
 * (`postgis_index_supportfn`) which, at plan time, rewrites `ST_Covers(a, b)`
 * into an indexable `a && b` when `a` is a plain reference to an indexed column.
 * Two things defeat that rewrite:
 *
 *   1. Wrapping the column. `ST_SetSRID(sa.geometry, 4326)` is an expression,
 *      not a column reference, so the support function does not fire and there
 *      is no expression index to match either. This matters because the SRID
 *      wrapper is not optional: `service_areas.geometry` is guaranteed 4326 by
 *      service_areas_geometry_srid_chk, but the point being tested against it
 *      usually originates in `customer.customer_location`, which is a bare
 *      `extensions.geometry` with SRID 0, and mixing them raises "Operation on
 *      mixed SRID geometries" the first time a real address is checked.
 *
 *   2. Correlating it per driver. Even with a bare column, a subquery reached by
 *      primary-key lookup from a driver row has already fetched the one row it
 *      is going to test. The bounding-box operator has nothing left to prune, so
 *      the index is irrelevant and every candidate pays a full exact test, on a
 *      polygon that may hold up to 10000 vertices (the ceiling
 *      service_areas_geometry_complexity_chk sets) and is therefore TOASTed and
 *      detoasted per evaluation.
 *
 * So this query resolves the covering areas FIRST, as a set, and joins drivers
 * to them afterwards. Both problems go away:
 *
 *   - `sa.geometry OPERATOR(extensions.&&) pts.geom` keeps the indexed column
 *     bare on the left of the bounding-box operator, which is the form
 *     idx_service_areas_geometry can answer. The point is built with its SRID
 *     already on it, so both operands are 4326 by construction and the operator
 *     cannot hit the mixed-SRID error. The `ST_SetSRID` on the geometry side of
 *     `ST_Covers` is then belt and braces, honouring the rule that both sides
 *     always carry an explicit SRID, and it costs nothing because by the time it
 *     runs the bounding-box pass has already reduced the candidates to the
 *     handful of polygons whose envelope actually contains the point.
 *
 *   - The exact test runs once per (point, candidate area), not once per
 *     (driver, area). Ten drivers sharing one downtown polygon test that polygon
 *     once between them, not ten times.
 *
 * NOTE FOR REVIEW: this reasoning is from the PostGIS and PostgreSQL
 * documentation, not from an EXPLAIN ANALYZE. This was written without a
 * database connection and nobody has seen the real plan. Confirm on the
 * dev/staging run that the plan over a non-trivial `service_areas` shows an
 * index scan on idx_service_areas_geometry rather than a sequential scan. A
 * sequential scan is not wrong, and for an organisation with a handful of
 * territories it is genuinely cheaper, so what matters is that it is the
 * planner's choice from a set-based query and not a shape that forecloses the
 * index. The planner may also legitimately prefer service_areas_organisation_id
 * _idx and filter on geometry; that is still set-based and still fine.
 *
 * ── ST_COVERS, NOT ST_CONTAINS ──────────────────────────────────────────────
 *
 * A dispatcher drawing two adjacent territories draws the shared edge down the
 * middle of a street, and addresses sit on streets. `ST_Contains` is false for a
 * point exactly on a boundary, so under it such an address would belong to
 * neither territory and nobody would cover it. `ST_Covers` is true for boundary
 * points, so it belongs to both and both drivers are eligible. That is also the
 * predicate `service_areas.geometry`'s own column comment already gives as its
 * worked example, so this follows the established precedent rather than setting
 * a new one.
 *
 * ── SOFT DELETE ─────────────────────────────────────────────────────────────
 *
 * `sa.is_deleted = false` is spelled out because nothing in the database will do
 * it: is_deleted is filtered in the query layer and never in RLS, matching
 * `vehicles.is_deleted`. Without it, packages route into territories a
 * dispatcher retired months ago.
 *
 * ── SCHEMA QUALIFICATION ────────────────────────────────────────────────────
 *
 * Every PostGIS call is `extensions.`-qualified and the bounding-box operator is
 * written as `OPERATOR(extensions.&&)`, even though the runtime connection's
 * search_path resolves them unqualified today (assignment.service.ts calls bare
 * `ST_X`). FixDriverLocationHistorySearchPath1787100900000 is what an unresolved
 * geometry operator costs when a search_path changes underneath it: not a "does
 * not exist" but an "operator is not unique", raised from a trigger, aborting
 * the statement. Pinning the schema here costs nothing and removes that whole
 * class of failure.
 *
 * ── TENANCY ─────────────────────────────────────────────────────────────────
 *
 * hikyaku-api connects as service_role, which bypasses RLS, so every tenancy
 * predicate in this query is explicit and load-bearing. Note that `eligible` is
 * joined to the driver side of the coverage rows as well, not just used to seed
 * the floater branch: even if a cross-tenant row somehow existed in
 * driver_service_area, a driver from another organisation could not come back
 * from this query.
 */
export const COVERING_DRIVERS_SQL = `
WITH pts AS (
    SELECT (p.ord - 1)::int AS point_index,
           extensions.st_setsrid(extensions.st_makepoint(p.lon, p.lat), 4326) AS geom
      FROM unnest($3::double precision[], $4::double precision[])
           WITH ORDINALITY AS p(lon, lat, ord)
),
eligible AS (
    SELECT d.id
      FROM drivers d
     WHERE d.organisation_id = $1::uuid
       AND d.warehouse_id    = $2::uuid
),
covering_areas AS (
    SELECT pts.point_index,
           sa.id AS service_area_id
      FROM pts
      JOIN service_areas sa
        ON  sa.organisation_id = $1::uuid
        AND sa.is_deleted      = false
        AND sa.geometry OPERATOR(extensions.&&) pts.geom
        AND extensions.st_covers(
                extensions.st_setsrid(sa.geometry, 4326),
                pts.geom)
)
-- The floater rule, SQL half: a driver with no rows at all in
-- driver_service_area covers everywhere. Returned ONCE, with a null
-- point_index, rather than joined against every point: the answer does not
-- depend on the point, and cross-joining it would multiply the result set by
-- the batch size for no information. applyFloaterRule() merges it in.
SELECT NULL::int AS point_index,
       e.id      AS driver_id,
       true      AS is_floater
  FROM eligible e
 WHERE NOT EXISTS (
           SELECT 1
             FROM driver_service_area dsa
            WHERE dsa.driver_id = e.id
       )
UNION ALL
-- Explicit coverage. DISTINCT because a driver assigned to two overlapping
-- areas that both contain the point must be returned once for that point, not
-- twice. Overlap is a legitimate configuration and there is deliberately no
-- constraint against it, so this is an expected case rather than a repair.
SELECT DISTINCT
       ca.point_index,
       dsa.driver_id,
       false AS is_floater
  FROM covering_areas ca
  JOIN driver_service_area dsa ON dsa.service_area_id = ca.service_area_id
  JOIN eligible            e   ON e.id = dsa.driver_id
`;

// ── Entry points ─────────────────────────────────────────────────────────────

/**
 * Which drivers cover each of these points, in ONE round trip.
 *
 * The batch form exists because the sequential `assignMany()` places packages
 * one at a time against the shifts as they stand after the previous one landed,
 * and adding a coverage lookup per package would turn a batch of 500 into 500
 * extra queries. Coverage does not change while a batch is being placed (only a
 * dispatcher editing territories changes it), so it is resolved once up front
 * and read from memory afterwards.
 *
 * Returns one entry per input point, index aligned with `points`, always in
 * order and always the same length. An empty `points` array short-circuits
 * without touching the database.
 *
 * Throws on an implausible coordinate rather than returning an empty answer for
 * it. See `isPlausibleLonLat`: a NaN longitude and a genuinely uncovered address
 * are indistinguishable in the result, and only one of them is a bug worth
 * waking somebody for. Callers that may hold ungeocoded records should filter
 * them out first, exactly as the assignment path already screens for a null
 * lon/lat before it does anything else.
 */
export async function coveringDriversForPoints(
    executor: CoverageQueryExecutor,
    query: CoverageQuery,
    points: readonly CoveragePoint[],
): Promise<PointCoverage[]> {
    if (points.length === 0) return [];

    points.forEach((point, index) => {
        if (!isPlausibleLonLat(point.lon, point.lat)) {
            throw new RangeError(
                `Coverage point ${index} is not a usable coordinate ` +
                    `(lon ${point.lon}, lat ${point.lat}). Longitude must be within ` +
                    `+/-180 and latitude within +/-90; a pair outside that is ` +
                    `usually a lon/lat swap or an ungeocoded address.`,
            );
        }
    });

    const rows = parseCoverageRows(
        await executor.query(COVERING_DRIVERS_SQL, [
            query.organisationId,
            query.warehouseId,
            points.map((p) => p.lon),
            points.map((p) => p.lat),
        ]),
    );

    const floaterDriverIds: string[] = [];
    const explicitByPointIndex = new Map<number, string[]>();

    for (const row of rows) {
        if (row.isFloater) {
            floaterDriverIds.push(row.driverId);
            continue;
        }
        // Only reachable with a null point_index if the two branches of the
        // UNION were edited apart from each other; skipping is the safe
        // direction, since the alternative is attributing coverage to point 0.
        if (row.pointIndex === null) continue;
        const forPoint = explicitByPointIndex.get(row.pointIndex);
        if (forPoint) forPoint.push(row.driverId);
        else explicitByPointIndex.set(row.pointIndex, [row.driverId]);
    }

    return applyFloaterRule(
        points.length,
        floaterDriverIds,
        explicitByPointIndex,
    );
}

/**
 * Which drivers cover this one point?
 *
 * A wrapper over the batch form, NOT a second query. See the module header: the
 * assignment path and the diagnostic endpoint have to be answering with the same
 * predicate, and the cheapest way to guarantee that is for there to be only one.
 */
export async function coveringDriversForPoint(
    executor: CoverageQueryExecutor,
    query: CoverageQuery,
    point: CoveragePoint,
): Promise<PointCoverage> {
    const [coverage] = await coveringDriversForPoints(executor, query, [point]);
    // coveringDriversForPoints returns exactly one entry per input point, so
    // this is total. The throw is here so that a future edit which breaks that
    // invariant fails loudly instead of returning undefined into a caller typed
    // to receive a PointCoverage.
    if (!coverage) {
        throw new Error(
            'Coverage query returned no entry for its single point.',
        );
    }
    return coverage;
}

// ── Row shape checking ───────────────────────────────────────────────────────

/**
 * Narrows what the pg driver handed back into `CoverageRow[]`.
 *
 * The compiler knows nothing about a raw query's result, so this is the one
 * place the shape is actually checked. It throws rather than filtering bad rows
 * out: a result that does not look like this one means the query and this file
 * have drifted apart, and dropping the rows we do not recognise would turn that
 * into drivers quietly going missing from dispatch decisions.
 *
 * Pure, and unit tested with no database.
 */
export function parseCoverageRows(raw: unknown): CoverageRow[] {
    if (!Array.isArray(raw)) {
        throw new TypeError(
            `Coverage query returned ${typeof raw}, expected an array of rows.`,
        );
    }

    return raw.map((entry: unknown, index: number): CoverageRow => {
        if (typeof entry !== 'object' || entry === null) {
            throw new TypeError(`Coverage row ${index} is not an object.`);
        }
        const row = entry as Record<string, unknown>;

        const driverId = row.driver_id;
        if (typeof driverId !== 'string') {
            throw new TypeError(
                `Coverage row ${index} has no driver_id (got ${typeof driverId}).`,
            );
        }

        const isFloater = row.is_floater;
        if (typeof isFloater !== 'boolean') {
            throw new TypeError(
                `Coverage row ${index} has no is_floater (got ${typeof isFloater}).`,
            );
        }

        const pointIndex = row.point_index;
        if (pointIndex === null || pointIndex === undefined) {
            return { pointIndex: null, driverId, isFloater };
        }
        // int4 arrives as a JS number, but a driver or a pooler configured to
        // hand back int as text would arrive as a string and silently key the
        // map by "0" instead of 0. Coerce and check rather than trust it.
        const asNumber = Number(pointIndex);
        if (!Number.isInteger(asNumber)) {
            throw new TypeError(
                `Coverage row ${index} has a non-integer point_index ` +
                    // JSON.stringify rather than String: the value is `unknown`
                    // here, and an object would otherwise land in the message as
                    // "[object Object]", which says nothing about what came back.
                    `(${JSON.stringify(pointIndex) ?? 'undefined'}).`,
            );
        }
        return { pointIndex: asNumber, driverId, isFloater };
    });
}
