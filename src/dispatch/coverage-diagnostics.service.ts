import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    coveringAreasForPoint,
    coveringDriversForPoint,
    isPlausibleLonLat,
    type CoveragePoint,
} from './coverage';
import type {
    CoverageAreaDto,
    CoverageAssignmentDto,
    CoverageDiagnosticDto,
    CoverageDriverDto,
} from './dto/coverage-diagnostic.dto';

/** The query string as the controller hands it over, unparsed. */
export interface CoverageQueryInput {
    packageId?: string;
    lon?: string;
    lat?: string;
    warehouseId?: string;
    includeGeometry?: string;
}

/** What the two accepted request forms reduce to once validated. */
type ResolvedRequest =
    | { form: 'package'; packageId: string; includeGeometry: boolean }
    | {
          form: 'coordinates';
          point: CoveragePoint;
          warehouseId: string | null;
          includeGeometry: boolean;
      };

interface PackageRow {
    id: string;
    tracking_number: string | null;
    warehouse_id: string | null;
    optimisation_id: string | null;
    lon: number | null;
    lat: number | null;
    driver_id: string | null;
    shift_status: string | null;
}

interface AreaDetailRow {
    id: string;
    driver_count: number | string;
    geometry: string | null;
}

/**
 * Why did this package go to that driver?
 *
 * A read-only explanation of one coverage decision, and nothing else. It exists
 * because the answer a dispatcher needs is not "here are the eligible drivers"
 * but "here is the point we tested, here is what matched it, here is who
 * actually got it, and here is whether those two agree".
 *
 * ── IT MUST NOT HAVE ITS OWN OPINION ────────────────────────────────────────
 *
 * Every containment answer in here comes from `coverage.ts`, through
 * `coveringDriversForPoint` and `coveringAreasForPoint`, which share one SQL
 * predicate between them. There is deliberately no ST_Covers, ST_Contains or
 * bounding-box test anywhere in this file, and adding one would be a bug rather
 * than an optimisation: a diagnostic that quietly disagrees with what dispatch
 * did sends whoever is debugging an incident down the wrong path with apparent
 * authority. The delivery point is resolved with the same expression
 * AssignmentService.loadPackage uses, for the same reason.
 *
 * ── ORG SCOPING IS ENTIRELY MANUAL ──────────────────────────────────────────
 *
 * This process connects as `service_role`, which bypasses RLS completely, so
 * every statement below carries an explicit `organisation_id = $n` taken from
 * the authenticated caller's org context (PermissionGuard sets it) and never
 * from the query string. A package id or a warehouse id belonging to another
 * tenant reads as unknown, never as forbidden, which is the same non-disclosure
 * rule ShiftsService and OptimisationService follow.
 */
@Injectable()
export class CoverageDiagnosticsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async explain(
        organisationId: string,
        input: CoverageQueryInput,
    ): Promise<CoverageDiagnosticDto> {
        const request = parseRequest(input);

        return request.form === 'package'
            ? this.explainPackage(organisationId, request)
            : this.explainCoordinates(organisationId, request);
    }

    // ── The package form ─────────────────────────────────────────────────────

    private async explainPackage(
        organisationId: string,
        request: Extract<ResolvedRequest, { form: 'package' }>,
    ): Promise<CoverageDiagnosticDto> {
        const pkg = await this.loadPackage(organisationId, request.packageId);
        if (!pkg) {
            throw new NotFoundException(
                'No package with this id in the organisation.',
            );
        }

        const assignment = toAssignment(pkg);
        const base = {
            packageId: pkg.id,
            trackingNumber: pkg.tracking_number,
            warehouseId: pkg.warehouse_id,
        };

        // Two states that are answers rather than errors. AssignmentService
        // treats an ungeocoded package as skipped('no_geocode') and never
        // assigns it, so "we never looked" is the true answer here; returning an
        // empty driver list instead would read exactly like a geocoded address
        // that genuinely nobody covers, which is a different problem with a
        // different fix.
        if (pkg.lon === null || pkg.lat === null) {
            return this.unevaluated(
                'package_not_geocoded',
                organisationId,
                { ...base, point: null },
                assignment,
            );
        }
        if (!pkg.warehouse_id) {
            return this.unevaluated(
                'package_has_no_warehouse',
                organisationId,
                { ...base, point: { lon: pkg.lon, lat: pkg.lat } },
                assignment,
            );
        }

        return this.evaluate(
            organisationId,
            pkg.warehouse_id,
            { lon: Number(pkg.lon), lat: Number(pkg.lat) },
            request.includeGeometry,
            base,
            assignment,
        );
    }

    // ── The coordinate form ──────────────────────────────────────────────────

    private async explainCoordinates(
        organisationId: string,
        request: Extract<ResolvedRequest, { form: 'coordinates' }>,
    ): Promise<CoverageDiagnosticDto> {
        const warehouseId = await this.resolveWarehouse(
            organisationId,
            request.warehouseId,
        );

        return this.evaluate(
            organisationId,
            warehouseId,
            request.point,
            request.includeGeometry,
            { packageId: null, trackingNumber: null, warehouseId },
            null,
        );
    }

    /**
     * Which warehouse's drivers to answer with.
     *
     * A supplied id is checked against the caller's organisation before it is
     * used. Skipping that check would not leak rows (coverage.ts filters by
     * organisation too, so a foreign warehouse simply matches no drivers) but it
     * would answer a cross-tenant probe with a confident "nobody covers this"
     * instead of "no such warehouse", which is worse than useless.
     */
    private async resolveWarehouse(
        organisationId: string,
        requested: string | null,
    ): Promise<string> {
        const rows: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM warehouse WHERE organisation_id = $1::uuid ORDER BY id`,
            [organisationId],
        );

        if (requested) {
            if (!rows.some((row) => row.id === requested)) {
                throw new NotFoundException(
                    'No warehouse with this id in the organisation.',
                );
            }
            return requested;
        }

        if (rows.length === 1) return rows[0].id;
        if (rows.length === 0) {
            throw new BadRequestException(
                'This organisation has no warehouses, so there are no drivers to ' +
                    'evaluate coverage against.',
            );
        }
        throw new BadRequestException(
            `This organisation has ${rows.length} warehouses. Pass warehouseId to ` +
                'say which one to evaluate coverage for.',
        );
    }

    // ── Evaluation ───────────────────────────────────────────────────────────

    /**
     * The shared answer both forms end at.
     *
     * Both coverage lookups are issued together: they are independent reads of
     * the same snapshot-consistent data and neither informs the other.
     */
    private async evaluate(
        organisationId: string,
        warehouseId: string,
        point: CoveragePoint,
        includeGeometry: boolean,
        base: {
            packageId: string | null;
            trackingNumber: string | null;
            warehouseId: string | null;
        },
        assignment: CoverageAssignmentDto | null,
    ): Promise<CoverageDiagnosticDto> {
        const query = { organisationId, warehouseId };

        const [coverage, areaCoverage, organisationAreaCount] =
            await Promise.all([
                coveringDriversForPoint(this.dataSource, query, point),
                coveringAreasForPoint(this.dataSource, query, point),
                this.countLiveAreas(organisationId),
            ]);

        const areas = await this.describeAreas(
            organisationId,
            warehouseId,
            areaCoverage.areas,
            includeGeometry,
        );

        const drivers: CoverageDriverDto[] = [
            ...coverage.explicitDriverIds.map(
                (driverId): CoverageDriverDto => ({
                    driverId,
                    matchedBy: 'explicit',
                }),
            ),
            ...coverage.floaterDriverIds.map((driverId): CoverageDriverDto => ({
                driverId,
                matchedBy: 'floater',
            })),
        ];

        const resolved = assignment
            ? resolveAssignment(
                  assignment,
                  coverage.explicitDriverIds,
                  coverage.floaterDriverIds,
              )
            : null;

        return {
            resolution: 'evaluated',
            explanation: explain({
                resolution: 'evaluated',
                areaCount: areas.length,
                organisationAreaCount,
                explicitCount: coverage.explicitDriverIds.length,
                floaterCount: coverage.floaterDriverIds.length,
                assignment: resolved,
            }),
            point: { lon: point.lon, lat: point.lat },
            warehouseId: base.warehouseId ?? warehouseId,
            packageId: base.packageId,
            trackingNumber: base.trackingNumber,
            anyAreaCovers: areas.length > 0,
            organisationAreaCount,
            areas,
            drivers,
            assignment: resolved,
        };
    }

    /** The answer when there was nothing to evaluate coverage at. */
    private async unevaluated(
        resolution: 'package_not_geocoded' | 'package_has_no_warehouse',
        organisationId: string,
        base: {
            packageId: string | null;
            trackingNumber: string | null;
            warehouseId: string | null;
            point: { lon: number; lat: number } | null;
        },
        assignment: CoverageAssignmentDto | null,
    ): Promise<CoverageDiagnosticDto> {
        const organisationAreaCount = await this.countLiveAreas(organisationId);

        return {
            resolution,
            explanation: explain({
                resolution,
                areaCount: 0,
                organisationAreaCount,
                explicitCount: 0,
                floaterCount: 0,
                assignment,
            }),
            point: base.point,
            warehouseId: base.warehouseId,
            packageId: base.packageId,
            trackingNumber: base.trackingNumber,
            anyAreaCovers: false,
            organisationAreaCount,
            areas: [],
            drivers: [],
            // The assignment is still reported. A package that is somehow on a
            // shift despite having no geocode is exactly the kind of thing this
            // endpoint exists to make visible.
            assignment: assignment
                ? { ...assignment, matchedBy: 'unassigned', covered: false }
                : null,
        };
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /**
     * The package, its delivery point and the shift it landed on.
     *
     * lon/lat come off the same column, through the same accessor, as
     * AssignmentService.loadPackage: if the two ever resolved a package's point
     * differently, this endpoint would explain a decision that was never made.
     * The only difference is that the PostGIS calls are schema-qualified here,
     * as coverage.ts qualifies its own, which selects the identical function.
     */
    private async loadPackage(
        organisationId: string,
        packageId: string,
    ): Promise<PackageRow | null> {
        const rows: PackageRow[] = await this.dataSource.query(
            `SELECT p.id,
                    p.tracking_number,
                    p.warehouse_id,
                    p.optimisation_id,
                    extensions.st_x(c.customer_location::extensions.geometry) AS lon,
                    extensions.st_y(c.customer_location::extensions.geometry) AS lat,
                    v.driver_id,
                    v.status AS shift_status
               FROM packages p
               LEFT JOIN customer c ON c.id = p.to_customer
               LEFT JOIN vrp_optimization v
                      ON v.id              = p.optimisation_id
                     AND v.organisation_id = p.organisation_id
              WHERE p.id = $1::uuid AND p.organisation_id = $2::uuid`,
            [packageId, organisationId],
        );
        return rows[0] ?? null;
    }

    /** Live territories in the organisation, staffed or not. */
    private async countLiveAreas(organisationId: string): Promise<number> {
        const rows: { count: number | string }[] = await this.dataSource.query(
            `SELECT count(*)::int AS count
               FROM service_areas
              WHERE organisation_id = $1::uuid AND is_deleted = false`,
            [organisationId],
        );
        return Number(rows[0]?.count ?? 0);
    }

    /**
     * Adds staffing (and, on request, geometry) to the territories that matched.
     *
     * Keyed by the ids coverage.ts already returned, so there is no second
     * containment test here. `driverCount` counts drivers at the warehouse being
     * evaluated, because a territory staffed only from another depot is
     * unstaffed as far as this package is concerned.
     */
    private async describeAreas(
        organisationId: string,
        warehouseId: string,
        areas: { id: string; name: string }[],
        includeGeometry: boolean,
    ): Promise<CoverageAreaDto[]> {
        if (areas.length === 0) return [];

        const rows: AreaDetailRow[] = await this.dataSource.query(
            `SELECT sa.id,
                    (SELECT count(*)
                       FROM driver_service_area dsa
                       JOIN drivers d ON d.id = dsa.driver_id
                      WHERE dsa.service_area_id = sa.id
                        AND d.organisation_id   = $2::uuid
                        AND d.warehouse_id      = $3::uuid)::int AS driver_count,
                    CASE WHEN $4::boolean
                         THEN extensions.st_asgeojson(sa.geometry)
                         ELSE NULL
                    END AS geometry
               FROM service_areas sa
              WHERE sa.id = ANY($1::uuid[])
                AND sa.organisation_id = $2::uuid`,
            [
                areas.map((area) => area.id),
                organisationId,
                warehouseId,
                includeGeometry,
            ],
        );

        const byId = new Map(rows.map((row) => [row.id, row]));

        return areas.map((area): CoverageAreaDto => {
            const detail = byId.get(area.id);
            const dto: CoverageAreaDto = {
                id: area.id,
                name: area.name,
                driverCount: Number(detail?.driver_count ?? 0),
            };
            if (includeGeometry) {
                dto.geometry = parseGeoJson(detail?.geometry ?? null);
            }
            return dto;
        });
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Turns the raw query string into one of the two accepted forms.
 *
 * Exactly one form per request. Accepting both and silently preferring one
 * would answer a question the caller did not ask, and a client that sends both
 * because it forgot to clear a field is a bug worth reporting rather than
 * papering over.
 *
 * Exported for tests: every 400 this endpoint can raise is decided here, with no
 * database involved.
 */
export function parseRequest(input: CoverageQueryInput): ResolvedRequest {
    const packageId = trimmed(input.packageId);
    const lon = trimmed(input.lon);
    const lat = trimmed(input.lat);
    const warehouseId = trimmed(input.warehouseId);
    const includeGeometry = parseIncludeGeometry(input.includeGeometry);

    const hasCoordinates = lon !== null || lat !== null;

    if (packageId && hasCoordinates) {
        throw new BadRequestException(
            'Pass either packageId or lon and lat, not both. They answer the ' +
                'same question from different starting points.',
        );
    }

    if (packageId) {
        if (warehouseId) {
            // The package names its own warehouse, and answering for a
            // different one would describe a decision that was never possible.
            throw new BadRequestException(
                'warehouseId cannot be combined with packageId; the package ' +
                    'already names the warehouse its coverage was evaluated at.',
            );
        }
        return { form: 'package', packageId, includeGeometry };
    }

    if (!hasCoordinates) {
        throw new BadRequestException(
            'Pass packageId, or lon and lat, to say which point to explain ' +
                'coverage for.',
        );
    }

    if (lon === null || lat === null) {
        throw new BadRequestException('lon and lat must be given together.');
    }

    const point = { lon: Number(lon), lat: Number(lat) };
    // The same predicate coverage.ts screens its own inputs with, so a
    // coordinate this endpoint accepts is exactly a coordinate coverage can
    // answer for. A lon/lat swap is the single most common client bug here and
    // silently points at the ocean, so it is rejected loudly.
    if (!isPlausibleLonLat(point.lon, point.lat)) {
        throw new BadRequestException(
            `lon ${lon} / lat ${lat} is not a usable coordinate. Longitude must ` +
                'be a number within +/-180 and latitude a number within +/-90; a ' +
                'pair outside that is usually a lon/lat swap.',
        );
    }

    return { form: 'coordinates', point, warehouseId, includeGeometry };
}

function trimmed(value: string | undefined): string | null {
    if (value === undefined) return null;
    const text = value.trim();
    return text.length === 0 ? null : text;
}

/**
 * Geometry is opt-in and only these spellings turn it on.
 *
 * An unrecognised value is rejected rather than read as false: silently
 * ignoring `includeGeometry=yes` would look like the server dropping the
 * geometry, which is a confusing thing to debug from the client side.
 */
function parseIncludeGeometry(value: string | undefined): boolean {
    const text = trimmed(value);
    if (text === null) return false;
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
    throw new BadRequestException(
        `includeGeometry must be true or false, not "${text}".`,
    );
}

/** The shift the package actually landed on, before coverage is compared. */
function toAssignment(pkg: PackageRow): CoverageAssignmentDto | null {
    if (!pkg.optimisation_id) return null;
    return {
        shiftId: pkg.optimisation_id,
        driverId: pkg.driver_id,
        shiftStatus: pkg.shift_status,
        matchedBy: 'unassigned',
        covered: false,
    };
}

/**
 * "Here is who should cover it, here is who actually got it."
 *
 * The comparison the whole endpoint exists for. `not_covering` is the answer
 * worth escalating: the package went to a driver that no territory selects and
 * who is not a floater either, so coverage did not produce this assignment.
 */
export function resolveAssignment(
    assignment: CoverageAssignmentDto,
    explicitDriverIds: readonly string[],
    floaterDriverIds: readonly string[],
): CoverageAssignmentDto {
    const driverId = assignment.driverId;
    if (!driverId) {
        return { ...assignment, matchedBy: 'unassigned', covered: false };
    }
    if (explicitDriverIds.includes(driverId)) {
        return { ...assignment, matchedBy: 'explicit', covered: true };
    }
    if (floaterDriverIds.includes(driverId)) {
        return { ...assignment, matchedBy: 'floater', covered: true };
    }
    return { ...assignment, matchedBy: 'not_covering', covered: false };
}

/** GeoJSON arrives from ST_AsGeoJSON as text and goes out as an object. */
function parseGeoJson(raw: string | null): Record<string, unknown> | null {
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        // Unparseable geometry must not fail the whole diagnostic: the drivers
        // and areas above are the answer, and the polygon was only ever an
        // optional extra.
        return null;
    }
}

interface ExplanationInput {
    resolution:
        'evaluated' | 'package_not_geocoded' | 'package_has_no_warehouse';
    areaCount: number;
    organisationAreaCount: number;
    explicitCount: number;
    floaterCount: number;
    assignment: CoverageAssignmentDto | null;
}

/**
 * One sentence a support engineer can paste into a ticket.
 *
 * Derived entirely from the fields it is given, so it can never say something
 * the structured answer does not. Pure, and unit tested as a table.
 */
export function explain(input: ExplanationInput): string {
    if (input.resolution === 'package_not_geocoded') {
        return (
            'This package has no delivery coordinates yet, so coverage was never ' +
            'evaluated for it. Automatic assignment skips packages in this state ' +
            'for the same reason, so this is not a territory problem.'
        );
    }
    if (input.resolution === 'package_has_no_warehouse') {
        return (
            'This package is not attached to a warehouse yet, so there is no set ' +
            'of drivers to evaluate coverage against.'
        );
    }

    const parts: string[] = [];

    if (input.areaCount > 0) {
        const noun = input.areaCount === 1 ? 'territory' : 'territories';
        const verb = input.areaCount === 1 ? 'covers' : 'cover';
        parts.push(`${input.areaCount} ${noun} ${verb} this point.`);
    } else if (input.organisationAreaCount === 0) {
        parts.push(
            'No territories are configured in this organisation, so every driver ' +
                'covers everywhere.',
        );
    } else {
        parts.push(
            `No territory covers this point, though the organisation has ` +
                `${input.organisationAreaCount} live.`,
        );
    }

    const total = input.explicitCount + input.floaterCount;
    if (total === 0) {
        parts.push('No driver at this warehouse covers it.');
    } else {
        parts.push(
            `${total} driver(s) cover it: ${input.explicitCount} by territory, ` +
                `${input.floaterCount} as floaters with no territories at all.`,
        );
    }

    if (input.assignment) {
        parts.push(assignmentSentence(input.assignment));
    }

    return parts.join(' ');
}

function assignmentSentence(assignment: CoverageAssignmentDto): string {
    switch (assignment.matchedBy) {
        case 'explicit':
            return 'It was assigned to a driver a territory selects for this point.';
        case 'floater':
            return (
                'It was assigned to a driver who matches only as a floater, ' +
                'meaning no territory has been drawn for them.'
            );
        case 'not_covering':
            return (
                'It was assigned to a driver who does not cover this point at ' +
                'all, so something other than coverage placed it.'
            );
        default:
            return 'It is not on a shift with a driver yet.';
    }
}
