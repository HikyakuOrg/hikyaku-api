import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    COVERAGE_OUTCOMES,
    COVERED_OUTCOMES,
    coveringAreasForPoint,
    coveringDriversForPoint,
    FALLBACK_OUTCOMES,
    isPlausibleLonLat,
    serviceAreaMatchingEnabled,
    type CoverageOutcome,
    type CoveragePoint,
} from './coverage';
import type {
    CoverageAreaDto,
    CoverageAssignmentDto,
    CoverageDiagnosticDto,
    CoverageDriverDto,
    CoverageFallbackPackageDto,
    CoverageOutcomeCountsDto,
    CoverageSummaryDto,
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
    recorded_outcome: string | null;
}

interface AreaDetailRow {
    id: string;
    driver_count: number | string;
    geometry: string | null;
}

/** One bucket of the summary's GROUP BY. */
interface OutcomeCountRow {
    outcome: string;
    count: number | string;
}

/** One package that reached a driver who does not cover it. */
interface FallbackRow {
    package_id: string;
    tracking_number: string | null;
    coverage_outcome: string;
    driver_id: string | null;
    optimisation_id: string | null;
    created_at: string;
}

/**
 * How far back the rollout summary looks when the caller does not say.
 *
 * A week, for two reasons that agree. Shift plans are daily and delivery
 * traffic has a strong weekday shape, so anything shorter than seven days
 * compares a Tuesday against a Sunday and reads the difference as a change in
 * coverage. And the rollout runbook asks for a week of watching after the flag
 * is turned on for an organisation, so the default window is the same window
 * that decision is actually made over.
 */
const DEFAULT_SUMMARY_DAYS = 7;

/**
 * The longest window the summary will answer for.
 *
 * Not a correctness limit, a cost one: the counts scan
 * package_assignment_coverage_outcome_idx over the range, and this endpoint is
 * a dispatcher's sanity check rather than an analytics warehouse. Thirty days
 * comfortably covers "has this got better since we turned it on".
 */
const MAX_SUMMARY_DAYS = 30;

/**
 * How many individual fallback packages the summary names.
 *
 * Enough to see the pattern (the same suburb over and over, or the same
 * driver), few enough that the response stays a summary. Anyone who needs all
 * of them is asking an analytics question, not a dispatch one.
 */
const MAX_FALLBACK_SAMPLE = 50;

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

    /**
     * The org-level rollout number: over the last N days, how much of the
     * automatically-assigned traffic reached a driver who covers it?
     *
     * ── WHY THIS IS AN ENDPOINT AND NOT A QUERY IN A RUNBOOK ────────────────
     *
     * It is the number somebody has to look at to decide whether to turn
     * SERVICE_AREA_MATCHING on, and again every day for a week afterwards. A
     * decision that is checked that often cannot depend on having a database
     * console open, or it will stop being checked.
     *
     * ── WHAT MAKES THE NUMBER HONEST ────────────────────────────────────────
     *
     * Three things, all of which are on the response rather than assumed:
     *
     *   - Only rows automatic assignment wrote are counted. A dispatcher's
     *     hand-pinned package took no coverage decision, so counting it either
     *     way would be wrong; those rows carry a null outcome and drop out.
     *   - `disabled` is excluded from the denominator. With the flag off,
     *     counting those as successes would report a perfect score for a
     *     feature that is not running.
     *   - The live territory count travels with it. An organisation that has
     *     drawn nothing scores 100%, entirely on floater matches, and that is
     *     the correct answer to the question asked rather than evidence the
     *     map is finished.
     */
    async summary(
        organisationId: string,
        days?: string,
    ): Promise<CoverageSummaryDto> {
        const windowDays = parseSummaryDays(days);

        const [counts, fallbacks, liveServiceAreaCount] = await Promise.all([
            this.countOutcomes(organisationId, windowDays),
            this.recentFallbacks(organisationId, windowDays),
            this.countLiveAreas(organisationId),
        ]);

        const byOutcome = toCountsDto(counts);
        const totalAssigned = COVERAGE_OUTCOMES.reduce(
            (total, outcome) => total + (counts.get(outcome) ?? 0),
            0,
        );
        const decisions = totalAssigned - (counts.get('disabled') ?? 0);
        const covered = COVERED_OUTCOMES.reduce(
            (total, outcome) => total + (counts.get(outcome) ?? 0),
            0,
        );
        // Null, not zero: a rate over no samples is unknown, and reporting an
        // unmeasured organisation as 0% covered would look like a failure.
        const coveredRate = decisions === 0 ? null : covered / decisions;

        const since = new Date(
            Date.now() - windowDays * 24 * 60 * 60 * 1000,
        ).toISOString();

        return {
            windowDays,
            since,
            serviceAreaMatching: serviceAreaMatchingEnabled(),
            liveServiceAreaCount,
            totalAssigned,
            decisions,
            coveredRate,
            byOutcome,
            fallbacks,
            explanation: explainSummary({
                windowDays,
                decisions,
                coveredRate,
                liveServiceAreaCount,
                serviceAreaMatching: serviceAreaMatchingEnabled(),
            }),
        };
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
     *
     * `coverage_outcome` is read alongside them because it is the only part of
     * this answer that is not recomputed: everything else on this response
     * describes the map as it is now, and this one column describes the map as
     * it was when the decision was taken. Reading it here rather than in a
     * second query keeps the two consistent with each other.
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
                    v.status AS shift_status,
                    pa.coverage_outcome AS recorded_outcome
               FROM packages p
               LEFT JOIN customer c ON c.id = p.to_customer
               LEFT JOIN package_assignment pa ON pa.package_id = p.id
               LEFT JOIN vrp_optimization v
                      ON v.id              = p.optimisation_id
                     AND v.organisation_id = p.organisation_id
              WHERE p.id = $1::uuid AND p.organisation_id = $2::uuid`,
            [packageId, organisationId],
        );
        return rows[0] ?? null;
    }

    /**
     * The five buckets, counted over the window.
     *
     * `coverage_outcome IS NOT NULL` is doing real work here: it is what
     * restricts the answer to packages automatic assignment placed. A replan or
     * a dispatcher's pin writes this same table with no outcome, and including
     * those would put packages that never took a coverage decision into the
     * denominator of a coverage success rate.
     *
     * The organisation predicate comes through `packages`, because
     * package_assignment has no organisation_id of its own. This process
     * connects as service_role and bypasses RLS, so that join is the only thing
     * scoping this read to one tenant.
     */
    private async countOutcomes(
        organisationId: string,
        windowDays: number,
    ): Promise<Map<CoverageOutcome, number>> {
        const rows: OutcomeCountRow[] = await this.dataSource.query(
            `SELECT pa.coverage_outcome AS outcome,
                    count(*)::int       AS count
               FROM package_assignment pa
               JOIN packages p ON p.id = pa.package_id
              WHERE p.organisation_id     = $1::uuid
                AND pa.coverage_outcome IS NOT NULL
                AND pa.created_at        >= now() - make_interval(days => $2::int)
              GROUP BY pa.coverage_outcome`,
            [organisationId, windowDays],
        );

        const counts = new Map<CoverageOutcome, number>();
        for (const row of rows) {
            const outcome = asCoverageOutcome(row.outcome);
            // A value this build does not know about is dropped rather than
            // added to a bucket it does not belong in. It would mean the column
            // and this code have drifted, most likely mid-deploy, and a wrong
            // bucket is worse than a slightly low total.
            if (outcome) counts.set(outcome, Number(row.count));
        }
        return counts;
    }

    /** The most recent fallbacks in the window, newest first, capped. */
    private async recentFallbacks(
        organisationId: string,
        windowDays: number,
    ): Promise<CoverageFallbackPackageDto[]> {
        const rows: FallbackRow[] = await this.dataSource.query(
            `SELECT pa.package_id,
                    p.tracking_number,
                    pa.coverage_outcome,
                    pa.driver_id,
                    p.optimisation_id,
                    pa.created_at
               FROM package_assignment pa
               JOIN packages p ON p.id = pa.package_id
              WHERE p.organisation_id    = $1::uuid
                AND pa.coverage_outcome  = ANY($3::text[])
                AND pa.created_at       >= now() - make_interval(days => $2::int)
              ORDER BY pa.created_at DESC
              LIMIT $4::int`,
            [
                organisationId,
                windowDays,
                [...FALLBACK_OUTCOMES],
                MAX_FALLBACK_SAMPLE,
            ],
        );

        return rows.flatMap((row): CoverageFallbackPackageDto[] => {
            const outcome = asCoverageOutcome(row.coverage_outcome);
            if (!outcome || !FALLBACK_OUTCOMES.includes(outcome)) return [];
            return [
                {
                    packageId: row.package_id,
                    trackingNumber: row.tracking_number,
                    outcome,
                    driverId: row.driver_id,
                    shiftId: row.optimisation_id,
                    assignedAt: new Date(row.created_at).toISOString(),
                },
            ];
        });
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
        recordedOutcome: asCoverageOutcome(pkg.recorded_outcome),
    };
}

/**
 * Narrows the raw column to the union, or null.
 *
 * A value the CHECK constraint permits but this build does not know about
 * (the two having drifted, most likely mid-deploy) is reported as null rather
 * than passed through: null already means "no recorded decision", which is a
 * safer thing for a client to render than a string its enum does not contain.
 */
function asCoverageOutcome(raw: string | null): CoverageOutcome | null {
    return raw !== null &&
        (COVERAGE_OUTCOMES as readonly string[]).includes(raw)
        ? (raw as CoverageOutcome)
        : null;
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

/**
 * How far back to count, from the raw query string.
 *
 * Rejected rather than clamped, on the same principle as `includeGeometry`
 * above: a caller who asks for 90 days and silently gets 30 has a number that
 * means something different from what they think it does, and a rollout
 * decision is exactly the wrong place for that.
 *
 * Exported for tests: every 400 this endpoint can raise is decided here, with
 * no database involved.
 */
export function parseSummaryDays(raw: string | undefined): number {
    const text = trimmed(raw);
    if (text === null) return DEFAULT_SUMMARY_DAYS;

    const days = Number(text);
    if (!Number.isInteger(days) || days < 1 || days > MAX_SUMMARY_DAYS) {
        throw new BadRequestException(
            `days must be a whole number between 1 and ${MAX_SUMMARY_DAYS}, ` +
                `not "${text}".`,
        );
    }
    return days;
}

/** The five buckets, zeros included, under the API's camelCase names. */
function toCountsDto(
    counts: ReadonlyMap<CoverageOutcome, number>,
): CoverageOutcomeCountsDto {
    return {
        covered: counts.get('covered') ?? 0,
        floater: counts.get('floater') ?? 0,
        fallbackNoCoveringCapacity:
            counts.get('fallback_no_covering_capacity') ?? 0,
        fallbackNoCoveringDriver:
            counts.get('fallback_no_covering_driver') ?? 0,
        disabled: counts.get('disabled') ?? 0,
    };
}

interface SummaryExplanationInput {
    windowDays: number;
    decisions: number;
    coveredRate: number | null;
    liveServiceAreaCount: number;
    serviceAreaMatching: boolean;
}

/**
 * One sentence for the rollout summary.
 *
 * Leads with whichever fact would make the rate misleading, because that is the
 * whole risk with this number: a perfect score on an empty map, or on a feature
 * that is switched off, reads as success to anyone skimming. Pure, and unit
 * tested as a table.
 */
export function explainSummary(input: SummaryExplanationInput): string {
    const parts: string[] = [];

    if (input.coveredRate === null) {
        parts.push(
            `No packages were placed by automatic assignment in the last ` +
                `${input.windowDays} day(s), so there is no coverage rate to ` +
                `report yet.`,
        );
    } else {
        parts.push(
            `${Math.round(input.coveredRate * 100)}% of ${input.decisions} ` +
                `coverage decision(s) over the last ${input.windowDays} day(s) ` +
                `reached a driver who covers the delivery point.`,
        );
    }

    if (input.liveServiceAreaCount === 0) {
        parts.push(
            'No territories are drawn in this organisation, so every driver ' +
                'covers everywhere and every match is a floater match. That is ' +
                'the correct answer, not a finished map.',
        );
    } else {
        parts.push(
            `${input.liveServiceAreaCount} live territory (or territories) are ` +
                'drawn.',
        );
    }

    if (!input.serviceAreaMatching) {
        parts.push(
            'Service area matching is currently switched off, so packages ' +
                'placed from now on are recorded as `disabled` and are left out ' +
                'of the rate above.',
        );
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
