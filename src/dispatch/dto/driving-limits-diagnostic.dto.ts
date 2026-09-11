import { ApiProperty } from '@nestjs/swagger';
import type { LimitDimension } from '../driving-limits-diagnostics';

/**
 * Response schema for GET /api/v1/dispatch/driving-limits/summary.
 *
 * The planning tool a fleet uses before switching DRIVING_LIMITS on: what did
 * shifts actually look like, and what would a proposed set of caps have done
 * to them. See CoverageDiagnosticsService's header for why this kind of
 * question gets its own read-only endpoint rather than a runbook query.
 */

/** min/p50/p90/max over one dimension's realised values, plus the sample size. */
export class DrivingLimitDistributionStatsDto {
    @ApiProperty({
        description: 'Realised shifts this dimension was computed over.',
    })
    count: number;

    @ApiProperty({ description: 'The best day.' })
    min: number;

    @ApiProperty({ description: 'The median day.' })
    p50: number;

    @ApiProperty({
        description:
            'The 90th percentile — a sane starting cap sits above this, not ' +
            'above the median, or one day in ten already breaches it before ' +
            'the flag is even switched on.',
    })
    p90: number;

    @ApiProperty({ description: 'The worst day in the window.' })
    max: number;
}

/** The four proposed caps, echoed back exactly as received. */
export class ProposedDrivingLimitsDto {
    @ApiProperty({
        type: Number,
        nullable: true,
        description:
            'Proposed cap on elapsed departure-to-return time, seconds.',
    })
    maxWorkingSeconds: number | null;

    @ApiProperty({
        type: Number,
        nullable: true,
        description: 'Proposed cap on travel-only time, seconds.',
    })
    maxDrivingSeconds: number | null;

    @ApiProperty({
        type: Number,
        nullable: true,
        description: 'Proposed cap on total route distance, metres.',
    })
    maxDistanceM: number | null;

    @ApiProperty({
        type: Number,
        nullable: true,
        description: 'Proposed cap on job stop count.',
    })
    maxStops: number | null;
}

/** One proposed cap this shift would have breached. */
export class DrivingLimitDimensionBreachDto {
    @ApiProperty({
        enum: ['working', 'driving', 'distance', 'stops'],
        description:
            '`working`: elapsed departure-to-return time. `driving`: travel-only ' +
            'time, ESTIMATED as elapsed time minus total service time (see the ' +
            'top-level `drivingSecondsIsEstimated` note — this codebase does not ' +
            'persist VROOM’s own travel-time figure on the path most shifts take). ' +
            '`distance`: total route distance. `stops`: job stop count.',
    })
    dimension: LimitDimension;

    @ApiProperty({
        description: 'What this shift actually measured on this dimension.',
    })
    actual: number;

    @ApiProperty({ description: 'The proposed cap it exceeded.' })
    limit: number;

    @ApiProperty({
        description:
            'Job stops on the part of the route past the point the cumulative ' +
            'figure first crosses the cap — the honest proxy for how much work ' +
            'would need re-placing were this cap enforced today. Not a claim ' +
            'about which stops an actual re-solve would drop.',
    })
    affectedStopCount: number;

    @ApiProperty({
        type: [String],
        format: 'uuid',
        description:
            'packages.id for each of the affectedStopCount stops above.',
    })
    affectedPackageIds: string[];
}

/** One realised shift that would have breached at least one proposed cap. */
export class DrivingLimitBreachingShiftDto {
    @ApiProperty({ format: 'uuid', description: 'vrp_optimization.id.' })
    shiftId: string;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    driverId: string | null;

    @ApiProperty({ type: String, format: 'date', nullable: true })
    shiftDate: string | null;

    @ApiProperty({ type: [DrivingLimitDimensionBreachDto] })
    dimensions: DrivingLimitDimensionBreachDto[];
}

/** Every dimension's distribution over the window, or null with zero shifts. */
export class DrivingLimitDistributionDto {
    @ApiProperty({ type: DrivingLimitDistributionStatsDto })
    workingSeconds: DrivingLimitDistributionStatsDto;

    @ApiProperty({
        type: DrivingLimitDistributionStatsDto,
        description:
            'ESTIMATED, not measured — see `drivingSecondsIsEstimated` on the ' +
            'parent response.',
    })
    drivingSeconds: DrivingLimitDistributionStatsDto;

    @ApiProperty({ type: DrivingLimitDistributionStatsDto })
    distanceM: DrivingLimitDistributionStatsDto;

    @ApiProperty({ type: DrivingLimitDistributionStatsDto })
    stopCount: DrivingLimitDistributionStatsDto;
}

/** 200 body of GET /api/v1/dispatch/driving-limits/summary. */
export class DrivingLimitsSummaryDto {
    @ApiProperty({
        description: 'How many days back the figures cover.',
        example: 30,
    })
    windowDays: number;

    @ApiProperty({
        format: 'date-time',
        description: 'The start of that window, so the figures can be quoted.',
    })
    since: string;

    @ApiProperty({
        description:
            'Whether DRIVING_LIMITS is switched on right now, so "we have not ' +
            'turned it on yet" is distinguishable from "we turned it on and ' +
            'nothing breached". Process-wide, not per organisation.',
    })
    drivingLimitsEnabled: boolean;

    @ApiProperty({
        description:
            'Realised shifts (status dispatched or completed) considered in ' +
            'the window. Zero means the distribution and breach list below are ' +
            'both empty for lack of data, not because nothing would breach.',
    })
    shiftCount: number;

    @ApiProperty({
        description:
            'True for every response: `driving` breaches and the driving-hours ' +
            'distribution are computed as elapsed time minus total service ' +
            'time, not from a measured travel-time figure. `ShiftPlanWriter`, ' +
            'the write path every Tier 1 placement and every continuous ' +
            'replan uses, never persists VROOM’s own travel-time column, so ' +
            'that figure is null for effectively every shift under the ' +
            '"instant" assignment mode this codebase runs. The estimate is ' +
            'exact unless a delivery deadline made the vehicle wait, which ' +
            'reads as extra driving here.',
    })
    drivingSecondsIsEstimated: true;

    @ApiProperty({
        type: DrivingLimitDistributionDto,
        nullable: true,
        description: 'Null when shiftCount is zero — nothing to summarise yet.',
    })
    distribution: DrivingLimitDistributionDto | null;

    @ApiProperty({ type: ProposedDrivingLimitsDto })
    proposedLimits: ProposedDrivingLimitsDto;

    @ApiProperty({
        type: [DrivingLimitBreachingShiftDto],
        description:
            'Every realised shift breaching at least one proposed cap, most ' +
            'recent shift_date first. Empty when no cap was proposed at all, ' +
            'which is a different answer from "none breached" — see ' +
            '`proposedLimits`.',
    })
    breachingShifts: DrivingLimitBreachingShiftDto[];

    @ApiProperty({
        description:
            'breachingShifts.length, for a client that only needs the count.',
    })
    totalBreachingShifts: number;

    @ApiProperty({
        description:
            'One sentence a dispatcher can act on, derived entirely from the ' +
            'fields above.',
        example:
            '30 realised shift(s) over the last 30 day(s); a 200,000 m distance ' +
            'cap would have breached 4 of them (11 packages on the affected ' +
            'portion of those routes). DRIVING_LIMITS is currently off.',
    })
    explanation: string;
}
