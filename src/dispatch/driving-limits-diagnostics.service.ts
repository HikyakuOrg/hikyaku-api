import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { drivingLimitsEnabled } from './driving-limits';
import {
    evaluateShiftBreaches,
    summariseDistribution,
    estimateDrivingSeconds,
    type DimensionBreach,
    type ProposedLimits,
    type ShiftMetrics,
    type ShiftStepRow,
} from './driving-limits-diagnostics';
import type {
    DrivingLimitBreachingShiftDto,
    DrivingLimitDimensionBreachDto,
    DrivingLimitDistributionDto,
    DrivingLimitsSummaryDto,
} from './dto/driving-limits-diagnostic.dto';

/** The query string as the controller hands it over, unparsed. */
export interface DrivingLimitsQueryInput {
    days?: string;
    maxWorkingSeconds?: string;
    maxDrivingSeconds?: string;
    maxDistanceM?: string;
    maxStops?: string;
}

/** One row of the realised-shift-metrics query. */
interface ShiftMetricsRow extends ShiftMetrics {
    routeId: string;
}

/**
 * How far back the summary looks when the caller does not say.
 *
 * Thirty days rather than coverage's seven: a driving-limit cap is chosen
 * once and left mostly alone, unlike a coverage rollout that is watched
 * daily, so the useful window is "a representative month", not "since
 * yesterday". Also the max — see MAX_SUMMARY_DAYS below for why there is no
 * point asking for more.
 */
const DEFAULT_SUMMARY_DAYS = 30;

/**
 * The longest window this endpoint will answer for.
 *
 * Not a correctness limit, a cost one, same reasoning as
 * CoverageDiagnosticsService.MAX_SUMMARY_DAYS: this is a dispatcher's
 * planning tool, not an analytics warehouse, and thirty days of one
 * organisation's shifts is already a representative sample of what a cap
 * would have to survive.
 */
const MAX_SUMMARY_DAYS = 30;

/**
 * Picking a driving-limit cap before switching DRIVING_LIMITS on, and
 * watching what it would have done to the fleet afterwards.
 *
 * ── WHY THE PROPOSED LIMITS ARE QUERY PARAMETERS, NOT THE CONFIGURED ONES ───
 *
 * That is what makes this a planning tool rather than a report. A
 * dispatcher can ask "what would 200 km have done to last month" without
 * saving anything to `driving_limit_profile` first — profiles are written
 * by the dashboard through PostgREST under RLS, and this process connects
 * as `service_role` and bypasses it, so a write path here would be a
 * second, weaker one around those policies. There is none.
 *
 * ── WHY DRIVING HOURS IS AN ESTIMATE ────────────────────────────────────────
 *
 * See `estimateDrivingSeconds` in driving-limits-diagnostics.ts: this
 * codebase's own write path for a Tier 1 placement or a continuous replan
 * never persists VROOM's measured travel-time figure, so it is recovered
 * from elapsed time minus total service time instead. `drivingSecondsIsEstimated`
 * on every response says so, deliberately, rather than presenting a
 * derived number as if it were measured.
 */
@Injectable()
export class DrivingLimitsDiagnosticsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async summary(
        organisationId: string,
        input: DrivingLimitsQueryInput,
    ): Promise<DrivingLimitsSummaryDto> {
        const windowDays = parseWindowDays(input.days);
        const proposedLimits = parseProposedLimits(input);

        const rows = await this.loadShiftMetrics(organisationId, windowDays);

        const distribution = summariseAll(rows);

        const hasProposal = Object.values(proposedLimits).some(
            (v) => v != null,
        );
        const breachingShifts: DrivingLimitBreachingShiftDto[] = [];
        if (hasProposal) {
            for (const row of rows) {
                // First pass, no step detail: cheap, and decides whether this
                // shift needs a second query at all. The common case while a
                // cap is still being picked is that most shifts do not breach.
                if (evaluateShiftBreaches(row, proposedLimits).length === 0) {
                    continue;
                }
                const steps = await this.loadShiftSteps(row.routeId);
                const breaches = evaluateShiftBreaches(
                    row,
                    proposedLimits,
                    steps,
                );
                breachingShifts.push({
                    shiftId: row.shiftId,
                    driverId: row.driverId,
                    shiftDate: row.shiftDate,
                    dimensions: breaches.map(toDimensionDto),
                });
            }
        }

        const since = new Date(
            Date.now() - windowDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const enabled = drivingLimitsEnabled();

        return {
            windowDays,
            since,
            drivingLimitsEnabled: enabled,
            shiftCount: rows.length,
            drivingSecondsIsEstimated: true,
            distribution,
            proposedLimits,
            breachingShifts,
            totalBreachingShifts: breachingShifts.length,
            explanation: explainSummary({
                windowDays,
                shiftCount: rows.length,
                hasProposal,
                breachingShifts,
                drivingLimitsEnabled: enabled,
            }),
        };
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /**
     * One row per realised shift: a `vrp_optimization` that actually got a
     * route (`JOIN LATERAL` behaves as an inner join, so a shift never
     * solved drops out on its own). `dispatched` or `completed` only — a
     * merely `planned` shift has not run yet, so its figures describe a
     * forecast, not a realised day.
     *
     * `working_seconds` and `stop_count` come from `vrp_route_step`, not
     * `vrp_route`, because the 'end' step's `arrival` and a `type = 'job'`
     * count are populated on EVERY write path (Tier 1's placements, the
     * continuous replan worker, and the on-demand batch solve). `vrp_route`'s
     * own `duration` is not — see `estimateDrivingSeconds`'s doc comment.
     */
    private async loadShiftMetrics(
        organisationId: string,
        windowDays: number,
    ): Promise<ShiftMetricsRow[]> {
        const rows: {
            shift_id: string;
            driver_id: string | null;
            shift_date: string | null;
            route_id: string;
            distance_m: number | null;
            working_seconds: number | null;
            stop_count: number | string;
        }[] = await this.dataSource.query(
            `SELECT v.id           AS shift_id,
                    v.driver_id,
                    v.shift_date,
                    route.route_id,
                    route.distance_m,
                    (SELECT rs.arrival
                       FROM vrp_route_step rs
                      WHERE rs.route_id = route.route_id AND rs.type = 'end'
                      LIMIT 1)     AS working_seconds,
                    (SELECT count(*)
                       FROM vrp_route_step rs
                      WHERE rs.route_id = route.route_id
                        AND rs.type    = 'job')::int AS stop_count
               FROM vrp_optimization v
               JOIN LATERAL (
                    SELECT r.id AS route_id, r.distance_m
                      FROM vrp_solution s
                      JOIN vrp_route    r ON r.solution_id = s.id
                     WHERE s.optimization_id = v.id
                     ORDER BY r.id
                     LIMIT 1
               ) route ON true
              WHERE v.organisation_id = $1::uuid
                AND v.status IN ('dispatched', 'completed')
                AND v.shift_date >= (current_date - make_interval(days => $2::int))
              ORDER BY v.shift_date DESC NULLS LAST, v.id`,
            [organisationId, windowDays],
        );

        return rows.map((row) => ({
            shiftId: row.shift_id,
            driverId: row.driver_id,
            shiftDate: row.shift_date,
            routeId: row.route_id,
            distanceM: row.distance_m,
            workingSeconds: row.working_seconds,
            stopCount: Number(row.stop_count),
        }));
    }

    /** Every job step of one route, in visiting order. */
    private async loadShiftSteps(routeId: string): Promise<ShiftStepRow[]> {
        const rows: {
            step_index: number;
            package_id: string | null;
            arrival: number | null;
            distance_m: number | null;
        }[] = await this.dataSource.query(
            `SELECT rs.step_index, rs.package_id, rs.arrival, rs.distance_m
               FROM vrp_route_step rs
              WHERE rs.route_id     = $1::uuid
                AND rs.type         = 'job'
                AND rs.package_id  IS NOT NULL
              ORDER BY rs.step_index`,
            [routeId],
        );

        return rows
            .filter(
                (row): row is typeof row & { package_id: string } =>
                    row.package_id !== null,
            )
            .map((row) => ({
                stepIndex: row.step_index,
                packageId: row.package_id,
                arrival: row.arrival ?? 0,
                distanceM: row.distance_m,
            }));
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function toDimensionDto(
    breach: DimensionBreach,
): DrivingLimitDimensionBreachDto {
    return {
        dimension: breach.dimension,
        actual: breach.actual,
        limit: breach.limit,
        affectedStopCount: breach.affectedStopCount,
        affectedPackageIds: [...breach.affectedPackageIds],
    };
}

/** Every dimension's distribution over the loaded rows, or null when empty. */
function summariseAll(
    rows: readonly ShiftMetrics[],
): DrivingLimitDistributionDto | null {
    if (rows.length === 0) return null;

    const workingSeconds = summariseDistribution(
        rows.map((r) => r.workingSeconds).filter((v): v is number => v != null),
    );
    const drivingSeconds = summariseDistribution(
        rows
            .map((r) => estimateDrivingSeconds(r.workingSeconds, r.stopCount))
            .filter((v): v is number => v != null),
    );
    const distanceM = summariseDistribution(
        rows.map((r) => r.distanceM).filter((v): v is number => v != null),
    );
    const stopCount = summariseDistribution(rows.map((r) => r.stopCount));

    // Every shift has a stop count, so `stopCount` is never null once `rows`
    // is non-empty; the other three can be null if every row genuinely has
    // no recorded figure, which the DTO's own per-field nullability does not
    // allow. Falling back to a zero-sample stat rather than widening the DTO
    // to nullable-per-dimension keeps the common case (all four populated)
    // simple; an organisation with literally no measured distance yet is
    // its own kind of "nothing to show" this endpoint does not need to
    // special-case further than reporting a zero-count stat block.
    const empty = { count: 0, min: 0, p50: 0, p90: 0, max: 0 };

    return {
        workingSeconds: workingSeconds ?? empty,
        drivingSeconds: drivingSeconds ?? empty,
        distanceM: distanceM ?? empty,
        stopCount: stopCount ?? empty,
    };
}

/**
 * How far back to summarise, from the raw query string.
 *
 * Rejected rather than clamped, same principle as
 * CoverageDiagnosticsService.parseSummaryDays: a caller who asks for 90
 * days and silently gets 30 has a number that means something different
 * from what they think it does, and a cap-picking decision is exactly the
 * wrong place for that.
 */
export function parseWindowDays(raw: string | undefined): number {
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

/**
 * The four proposed caps, from the raw query string.
 *
 * Any subset may be sent; an absent one means "not proposing a cap on this
 * dimension", not zero. Each is parsed with the same rule
 * driving_limit_profile's own CHECK constraints enforce (a positive
 * integer), so a value this endpoint accepts is exactly a value the
 * dashboard would let a dispatcher save.
 */
export function parseProposedLimits(
    input: DrivingLimitsQueryInput,
): ProposedLimits {
    return {
        maxWorkingSeconds: parsePositiveInt(
            'maxWorkingSeconds',
            input.maxWorkingSeconds,
        ),
        maxDrivingSeconds: parsePositiveInt(
            'maxDrivingSeconds',
            input.maxDrivingSeconds,
        ),
        maxDistanceM: parsePositiveInt('maxDistanceM', input.maxDistanceM),
        maxStops: parsePositiveInt('maxStops', input.maxStops),
    };
}

function parsePositiveInt(
    field: string,
    raw: string | undefined,
): number | null {
    const text = trimmed(raw);
    if (text === null) return null;

    const value = Number(text);
    if (!Number.isInteger(value) || value <= 0) {
        throw new BadRequestException(
            `${field} must be a positive whole number, not "${text}".`,
        );
    }
    return value;
}

function trimmed(value: string | undefined): string | null {
    if (value === undefined) return null;
    const text = value.trim();
    return text.length === 0 ? null : text;
}

interface SummaryExplanationInput {
    windowDays: number;
    shiftCount: number;
    hasProposal: boolean;
    breachingShifts: readonly DrivingLimitBreachingShiftDto[];
    drivingLimitsEnabled: boolean;
}

/**
 * One sentence a dispatcher can act on.
 *
 * Derived entirely from the fields it is given, so it can never say
 * something the structured answer does not. Pure, and unit tested as a
 * table, mirroring CoverageDiagnosticsService.explainSummary.
 */
export function explainSummary(input: SummaryExplanationInput): string {
    const parts: string[] = [];

    if (input.shiftCount === 0) {
        parts.push(
            `No realised shifts in the last ${input.windowDays} day(s), so ` +
                'there is nothing to compare a proposed cap against yet.',
        );
    } else {
        parts.push(
            `${input.shiftCount} realised shift(s) over the last ` +
                `${input.windowDays} day(s).`,
        );
        if (input.hasProposal) {
            if (input.breachingShifts.length === 0) {
                parts.push(
                    'The proposed limit(s) would not have breached any of them.',
                );
            } else {
                const affected = input.breachingShifts.reduce(
                    (sum, shift) =>
                        sum +
                        shift.dimensions.reduce(
                            (dimSum, dim) => dimSum + dim.affectedStopCount,
                            0,
                        ),
                    0,
                );
                parts.push(
                    `The proposed limit(s) would have breached ` +
                        `${input.breachingShifts.length} of them ` +
                        `(${affected} package(s) on the affected portion of ` +
                        'those routes).',
                );
            }
        }
    }

    parts.push(
        input.drivingLimitsEnabled
            ? 'DRIVING_LIMITS is currently on.'
            : 'DRIVING_LIMITS is currently off.',
    );

    return parts.join(' ');
}
