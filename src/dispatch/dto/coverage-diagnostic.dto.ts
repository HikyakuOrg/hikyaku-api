import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    COVERAGE_OUTCOMES,
    FALLBACK_OUTCOMES,
    type CoverageOutcome,
} from '../coverage';

/**
 * Response schemas for GET /api/v1/dispatch/coverage.
 *
 * Everything here is shaped around one support question: "why did package X go
 * to driver Y?". So the answer is deliberately not a bare list of driver ids. It
 * carries the point that was actually tested, the territories that matched, the
 * drivers that matched and WHY each of them matched, and (for the package form)
 * who actually got it, so the two can be compared without a second request.
 */

/** The delivery point coverage was evaluated at, echoed back. */
export class CoveragePointDto {
    @ApiProperty({
        description:
            'Longitude, WGS84. Always in lon/lat order, as PostGIS is.',
        example: 103.851959,
    })
    lon: number;

    @ApiProperty({ description: 'Latitude, WGS84.', example: 1.29027 })
    lat: number;
}

/** One territory whose geometry covers the point. */
export class CoverageAreaDto {
    @ApiProperty({ format: 'uuid', description: 'service_areas.id.' })
    id: string;

    @ApiProperty({ description: 'The name a dispatcher gave the territory.' })
    name: string;

    @ApiProperty({
        description:
            'How many drivers at this warehouse are staffed on this area. Zero ' +
            'means the territory was drawn and then left unstaffed, which reads ' +
            'identically to "no territory here" from the driver list alone.',
        example: 2,
    })
    driverCount: number;

    @ApiPropertyOptional({
        type: 'object',
        additionalProperties: true,
        nullable: true,
        description:
            'GeoJSON MultiPolygon, present only when `includeGeometry=true` was ' +
            'passed. Omitted by default: a handful of city-sized territories is ' +
            'megabytes of coordinates that a coverage question does not need.',
    })
    geometry?: Record<string, unknown> | null;
}

/**
 * One driver who covers the point, and the reason they do.
 *
 * The two reasons are not interchangeable and merging them would make the tool
 * lie during rollout, when almost every driver still has no territories and so
 * matches everything: `explicit` is a decision somebody made, `floater` is the
 * absence of one.
 */
export class CoverageDriverDto {
    @ApiProperty({ format: 'uuid', description: 'drivers.id.' })
    driverId: string;

    @ApiProperty({
        enum: ['explicit', 'floater'],
        description:
            '`explicit`: a territory this driver is staffed on contains the ' +
            'point. `floater`: this driver has no territories at all and so ' +
            'covers everywhere, which is what keeps an unconfigured ' +
            'organisation behaving exactly as it did before territories existed.',
    })
    matchedBy: 'explicit' | 'floater';
}

/**
 * Who actually got the package, next to who should have covered it.
 *
 * Present only for the `packageId` form: without a package there is no
 * assignment to compare against.
 */
export class CoverageAssignmentDto {
    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'vrp_optimization.id, or null if not on a shift yet.',
    })
    shiftId: string | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'The driver on that shift, or null.',
    })
    driverId: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Status of the shift the package sits on.',
        example: 'planned',
    })
    shiftStatus: string | null;

    @ApiProperty({
        enum: ['explicit', 'floater', 'not_covering', 'unassigned'],
        description:
            'How the driver that actually got this package relates to the ' +
            'coverage above. `explicit` and `floater` mirror the driver list. ' +
            '`not_covering` is the interesting one: the package went to a driver ' +
            'no territory selects and who is not a floater either, so coverage ' +
            'did not produce this assignment. `unassigned` means no shift or no ' +
            'driver on it yet.',
    })
    matchedBy: 'explicit' | 'floater' | 'not_covering' | 'unassigned';

    @ApiProperty({
        description:
            'Shorthand for `matchedBy` being explicit or floater. False on an ' +
            'assignment coverage does not explain, which is the case worth ' +
            'escalating.',
    })
    covered: boolean;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        enum: [...COVERAGE_OUTCOMES],
        description:
            'What the assignment engine recorded WHEN IT PLACED THIS PACKAGE ' +
            '(`package_assignment.coverage_outcome`), as opposed to `matchedBy` ' +
            'above, which is recomputed against the territories as they stand ' +
            'right now.\n\n' +
            'The two disagreeing is not a bug, it is the most useful thing on ' +
            'this response: it means the map changed after the package was ' +
            'placed. A package recorded as `covered` that now reads ' +
            '`not_covering` was routed correctly and then had its territory ' +
            'redrawn underneath it.\n\n' +
            '`floater` is kept distinct from `covered` because during rollout ' +
            'most matches are floater matches, and merging them would report ' +
            'the feature as working better than it is. `disabled` means ' +
            'SERVICE_AREA_MATCHING was off and no coverage question was asked. ' +
            'Null means no automatic assignment wrote this row: the package ' +
            'was pinned by a dispatcher, or it predates this column.',
    })
    recordedOutcome: CoverageOutcome | null;
}

/** 200 body of GET /api/v1/dispatch/coverage. */
export class CoverageDiagnosticDto {
    @ApiProperty({
        enum: ['evaluated', 'package_not_geocoded', 'package_has_no_warehouse'],
        description:
            'Whether coverage could be evaluated at all. The two failure values ' +
            'are answers, not errors: a package with no geocode is exactly what ' +
            'AssignmentService skips as `no_geocode` and never assigns, and an ' +
            'empty driver list would otherwise be indistinguishable from a ' +
            'geocoded address that genuinely nobody covers.',
    })
    resolution:
        'evaluated' | 'package_not_geocoded' | 'package_has_no_warehouse';

    @ApiProperty({
        description:
            'One sentence a support engineer can paste into a ticket. Derived ' +
            'entirely from the fields below; it adds no information of its own.',
        example:
            'No territory covers this address; 3 driver(s) match only because ' +
            'they have no territories at all.',
    })
    explanation: string;

    @ApiProperty({
        type: CoveragePointDto,
        nullable: true,
        description:
            'The point coverage was evaluated at. Null when it could not be ' +
            'resolved. Echoed back because roughly half of these questions turn ' +
            'out to be a bad geocode rather than a bad territory, and seeing the ' +
            'coordinates is what makes that obvious immediately.',
    })
    point: CoveragePointDto | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'The warehouse whose drivers were considered. Resolved from the ' +
            'package, or from `warehouseId`, or from the organisation when it ' +
            'has exactly one warehouse.',
    })
    warehouseId: string | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'Echo of `packageId`, or null for the coordinate form.',
    })
    packageId: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'The package’s tracking number, since a support question usually ' +
            'starts from one.',
    })
    trackingNumber: string | null;

    @ApiProperty({
        description:
            'True when at least one territory covers the point. Kept separate ' +
            'from the driver list so "nobody covers this", "territories exist ' +
            'but none match here" and "everyone matches, as floaters" are three ' +
            'distinguishable answers rather than one empty array.',
    })
    anyAreaCovers: boolean;

    @ApiProperty({
        description:
            'Live (not soft-deleted) territories in the whole organisation. Zero ' +
            'means nothing has been configured yet, which is the expected state ' +
            'during rollout and is very different from territories existing and ' +
            'not matching.',
        example: 4,
    })
    organisationAreaCount: number;

    @ApiProperty({
        type: [CoverageAreaDto],
        description:
            'Every live territory containing the point, staffed or not, ordered ' +
            'by name. Not filtered by warehouse: an unstaffed territory over the ' +
            'address is the most useful thing this endpoint can show.',
    })
    areas: CoverageAreaDto[];

    @ApiProperty({
        type: [CoverageDriverDto],
        description:
            'Every driver at the warehouse who covers the point, explicit ' +
            'matches first, each group ordered by id.',
    })
    drivers: CoverageDriverDto[];

    @ApiProperty({
        type: CoverageAssignmentDto,
        nullable: true,
        description:
            'Null for the coordinate form. For the package form, who actually ' +
            'got it and whether coverage explains that.',
    })
    assignment: CoverageAssignmentDto | null;
}

/**
 * The five outcome buckets as counts.
 *
 * Named in camelCase to match the rest of this API, even though the stored
 * values are snake_case; the mapping is in CoverageDiagnosticsService and
 * nowhere else.
 */
export class CoverageOutcomeCountsDto {
    @ApiProperty({
        description: 'A territory the driver is staffed on contains the point.',
    })
    covered: number;

    @ApiProperty({
        description:
            'The driver matched only because they have no territories at all. ' +
            'Expect this to be most of the traffic while the map is being ' +
            'drawn, which is exactly why it is not folded into `covered`.',
    })
    floater: number;

    @ApiProperty({
        description:
            'Somebody covers the point, but no covering driver had room and ' +
            'none was idle. An understaffed territory, or a busy day.',
    })
    fallbackNoCoveringCapacity: number;

    @ApiProperty({
        description:
            'Nobody covers the point at all. Usually a territory that was ' +
            'never drawn, or one drawn and left unstaffed.',
    })
    fallbackNoCoveringDriver: number;

    @ApiProperty({
        description:
            'SERVICE_AREA_MATCHING was off when the package was placed, so no ' +
            'coverage question was asked. Excluded from `decisions` and from ' +
            'the rate below.',
    })
    disabled: number;
}

/** One package that went to a driver who does not cover its address. */
export class CoverageFallbackPackageDto {
    @ApiProperty({ format: 'uuid' })
    packageId: string;

    @ApiProperty({ type: String, nullable: true })
    trackingNumber: string | null;

    @ApiProperty({
        enum: [...FALLBACK_OUTCOMES],
        description: 'Which of the two fallback outcomes this was.',
    })
    outcome: CoverageOutcome;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'The driver who got it despite not covering the point.',
    })
    driverId: string | null;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    shiftId: string | null;

    @ApiProperty({
        format: 'date-time',
        description: 'When the package was placed on that shift.',
    })
    assignedAt: string;
}

/**
 * 200 body of GET /api/v1/dispatch/coverage/summary.
 *
 * The number somebody looks at before turning SERVICE_AREA_MATCHING on, and
 * the one they watch afterwards. Everything on it exists to stop the headline
 * rate being read out of context: an organisation with no territories is 100%
 * floater and that is correct, and an organisation with the flag off is 100%
 * `disabled` and the rate means nothing at all.
 */
export class CoverageSummaryDto {
    @ApiProperty({
        description: 'How many days back the counts cover.',
        example: 7,
    })
    windowDays: number;

    @ApiProperty({
        format: 'date-time',
        description: 'The start of that window, so the counts can be quoted.',
    })
    since: string;

    @ApiProperty({
        description:
            'Whether service area matching is switched on for the process ' +
            'answering this request. False means new packages are being ' +
            'recorded as `disabled` and the rate below describes history, not ' +
            'what is happening now. Process-wide, not per organisation.',
    })
    serviceAreaMatching: boolean;

    @ApiProperty({
        description:
            'Live (not soft-deleted) territories in this organisation. Zero ' +
            'means nothing has been drawn, so every driver covers everywhere ' +
            'and a 100% floater rate is the correct answer rather than a good ' +
            'one.',
    })
    liveServiceAreaCount: number;

    @ApiProperty({
        description:
            'Packages placed by automatic assignment in the window. Excludes ' +
            'anything a dispatcher pinned by hand and anything placed before ' +
            'outcomes were recorded, neither of which took a coverage decision.',
    })
    totalAssigned: number;

    @ApiProperty({
        description:
            '`totalAssigned` minus the `disabled` ones: the packages a ' +
            'coverage question was actually asked about. The denominator of ' +
            '`coveredRate`.',
    })
    decisions: number;

    @ApiProperty({
        type: Number,
        nullable: true,
        description:
            'THE NUMBER. The fraction of `decisions` that reached a driver who ' +
            'covers the delivery point, counting both `covered` and `floater`. ' +
            '1 means coverage placed everything; the shortfall is the fallback ' +
            'rate. Null when `decisions` is zero, because a rate over no ' +
            'samples is not zero, it is unknown.',
        example: 0.94,
    })
    coveredRate: number | null;

    @ApiProperty({ type: CoverageOutcomeCountsDto })
    byOutcome: CoverageOutcomeCountsDto;

    @ApiProperty({
        type: [CoverageFallbackPackageDto],
        description:
            'The most recent packages in the window that went to a driver who ' +
            'does not cover them, newest first, capped at 50. This is the ' +
            '"which packages, and why" answer; pass any of these ids to ' +
            'GET /api/v1/dispatch/coverage for the full explanation of one.',
    })
    fallbacks: CoverageFallbackPackageDto[];

    @ApiProperty({
        description:
            'One sentence a dispatcher can act on, derived entirely from the ' +
            'fields above.',
        example:
            '94% of 312 coverage decision(s) reached a covering driver over ' +
            'the last 7 day(s), across 6 live territory (or territories).',
    })
    explanation: string;
}
