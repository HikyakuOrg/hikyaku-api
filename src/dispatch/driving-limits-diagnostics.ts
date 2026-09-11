/**
 * Pure evaluation for the driving-limits diagnostic: given how a shift
 * actually ran and a PROPOSED set of caps, which dimensions would it have
 * breached, and how much of the route sits past the breach.
 *
 * Same split as insertion.ts and driving-limits.ts: nothing here touches a
 * database. `driving-limits-diagnostics.service.ts` loads the rows and calls
 * in here for the answers, which is what makes "does 200 km bind harder than
 * the org's realised worst day" a table of inputs and expected outputs
 * rather than a query nobody can unit test.
 */

import { TIME_PER_STOP } from './insertion';

// ── Plain data ───────────────────────────────────────────────────────────────

/** One realised shift's aggregate figures, as persisted. */
export interface ShiftMetrics {
    shiftId: string;
    driverId: string | null;
    /** ISO date, or null on the rare row with no shift_date recorded. */
    shiftDate: string | null;
    /**
     * Elapsed seconds from departure to return — the 'end' job step's
     * `arrival`, which is relative-from-departure on every path that writes
     * it. This is the true measure for `maxWorkingSeconds`: it already
     * includes service, setup and waiting, exactly as the vehicle
     * `time_window` VROOM enforces it against does. Null when the route has
     * no recorded return (an in-progress or malformed row).
     */
    workingSeconds: number | null;
    /**
     * Total route distance, metres (`vrp_route.distance_m`). Null when
     * neither tier has measured or estimated it yet.
     */
    distanceM: number | null;
    /** Count of job steps — deliveries, not the start/end bookends. */
    stopCount: number;
}

/** One job step of a shift's route, in visiting order. */
export interface ShiftStepRow {
    stepIndex: number;
    packageId: string;
    /** Relative-from-departure seconds, cumulative by construction. */
    arrival: number;
    /** Metres of the leg ARRIVING at this step — not cumulative. */
    distanceM: number | null;
}

/** The four caps being proposed, any of which may be left unset. */
export interface ProposedLimits {
    maxWorkingSeconds: number | null;
    maxDrivingSeconds: number | null;
    maxDistanceM: number | null;
    maxStops: number | null;
}

export type LimitDimension = 'working' | 'driving' | 'distance' | 'stops';

/** One dimension a shift breached against the proposed caps. */
export interface DimensionBreach {
    dimension: LimitDimension;
    actual: number;
    limit: number;
    /**
     * Packages sitting on the part of the route past the breach — the honest
     * proxy for how many would need re-placing were this cap enforced today.
     * Empty (not null) when the step detail needed to attribute individual
     * packages was not loaded for this shift; `affectedStopCount` still
     * holds either way.
     */
    affectedPackageIds: readonly string[];
    /** Same measure as a count, always populated even without step detail. */
    affectedStopCount: number;
}

// ── No persisted travel-only time on the common path ────────────────────────

/**
 * Estimated travel-only seconds for a shift, since `vrp_route.duration`
 * (VROOM's own travel-time figure) is only ever written by the on-demand
 * batch path (`DatabaseService.insertOptimisedRoutes` /
 * `insertAdhocRoutes`). `ShiftPlanWriter.writePlan` — the path EVERY
 * Tier 1 placement and EVERY continuous replan uses, i.e. effectively every
 * shift under the "instant" assignment mode this codebase actually runs —
 * never touches `duration` on either `vrp_route` or `vrp_route_step`. For
 * most real shifts it is simply null, so building the driving-hours
 * dimension on it would report a rounding error's worth of data.
 *
 * What IS reliably persisted on every path is `workingSeconds` (the elapsed
 * time from departure to return) and the stop count. VROOM's own job
 * `service` is always exactly TIME_PER_STOP for every job this codebase
 * sends (see replan.worker.ts and database.service.ts, both of which set
 * `service: TIME_PER_STOP` unconditionally), so travel time is recoverable
 * as elapsed time minus total service time, PROVIDED the vehicle never had
 * to wait for a job's time window to open.
 *
 * That proviso is the one honest caveat: a route with a tight deadline can
 * carry real `waiting_time`, which this counts as travel and is not. It is
 * a planning estimate, not a gate — Tier 1's actual `max_driving_seconds`
 * enforcement (HIK-83/84) never goes through this function — so a dispatcher
 * reads it as "roughly this many hours of driving", not as a promise.
 */
export function estimateDrivingSeconds(
    workingSeconds: number | null,
    stopCount: number,
): number | null {
    if (workingSeconds == null) return null;
    return Math.max(0, workingSeconds - stopCount * TIME_PER_STOP);
}

// ── Distribution ─────────────────────────────────────────────────────────────

export interface DistributionStats {
    count: number;
    min: number;
    p50: number;
    p90: number;
    max: number;
}

/**
 * Linear-interpolated percentile over a small in-memory sample.
 *
 * A diagnostics endpoint's sample is, at most, a month of one organisation's
 * shifts — hundreds, not millions — so sorting in Node rather than pushing
 * `percentile_cont` onto Postgres keeps four dimensions' worth of stats as
 * one pass over already-fetched rows instead of four correlated aggregate
 * queries.
 */
export function percentile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) {
        throw new RangeError('percentile of an empty sample is undefined.');
    }
    if (sorted.length === 1) return sorted[0];
    const rank = p * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    const weight = rank - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** Null when there is nothing to summarise — a realised-shift count of zero. */
export function summariseDistribution(
    values: readonly number[],
): DistributionStats | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return {
        count: sorted.length,
        min: sorted[0],
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        max: sorted[sorted.length - 1],
    };
}

// ── Breach evaluation ────────────────────────────────────────────────────────

/**
 * Which of the four proposed caps would this shift have breached, and by
 * how much?
 *
 * `steps`, when supplied, must be every JOB step of this shift's route, in
 * visiting order (ascending `stepIndex`) — used only to attribute the
 * breaching packages, never to recompute whether a breach happened at all
 * (that always comes from `metrics`, the same aggregate figures the
 * distribution above is built from, so the two can never disagree about
 * WHETHER a shift breached, only about which packages it names).
 *
 * "The affected packages" is the trailing portion of the route past the
 * point the cumulative figure first crosses the cap — the last N stops, for
 * whichever N brings the route back under it. That is a defensible reading
 * of "how much would need re-placing", not a claim about what an actual
 * re-solve would keep: VROOM does not have to drop exactly the tail.
 */
export function evaluateShiftBreaches(
    metrics: ShiftMetrics,
    limits: ProposedLimits,
    steps?: readonly ShiftStepRow[],
): DimensionBreach[] {
    const breaches: DimensionBreach[] = [];

    if (
        limits.maxWorkingSeconds != null &&
        metrics.workingSeconds != null &&
        metrics.workingSeconds > limits.maxWorkingSeconds
    ) {
        breaches.push(
            breach(
                'working',
                metrics.workingSeconds,
                limits.maxWorkingSeconds,
                steps,
                (step) => step.arrival,
            ),
        );
    }

    const drivingSeconds = estimateDrivingSeconds(
        metrics.workingSeconds,
        metrics.stopCount,
    );
    if (
        limits.maxDrivingSeconds != null &&
        drivingSeconds != null &&
        drivingSeconds > limits.maxDrivingSeconds
    ) {
        breaches.push(
            breach(
                'driving',
                drivingSeconds,
                limits.maxDrivingSeconds,
                steps,
                (step, jobPosition) =>
                    step.arrival - jobPosition * TIME_PER_STOP,
            ),
        );
    }

    if (
        limits.maxDistanceM != null &&
        metrics.distanceM != null &&
        metrics.distanceM > limits.maxDistanceM
    ) {
        let cumulative = 0;
        breaches.push(
            breach(
                'distance',
                metrics.distanceM,
                limits.maxDistanceM,
                steps,
                (step) => (cumulative += step.distanceM ?? 0),
            ),
        );
    }

    if (limits.maxStops != null && metrics.stopCount > limits.maxStops) {
        const excess = metrics.stopCount - limits.maxStops;
        breaches.push({
            dimension: 'stops',
            actual: metrics.stopCount,
            limit: limits.maxStops,
            affectedStopCount: excess,
            affectedPackageIds: steps
                ? steps.slice(-excess).map((s) => s.packageId)
                : [],
        });
    }

    return breaches;
}

/**
 * Shared shape for the three cumulative dimensions: walk the steps in order,
 * find the first whose running figure crosses `limit`, and call everything
 * from there on affected.
 */
function breach(
    dimension: LimitDimension,
    actual: number,
    limit: number,
    steps: readonly ShiftStepRow[] | undefined,
    cumulativeAt: (step: ShiftStepRow, jobPosition: number) => number,
): DimensionBreach {
    if (!steps || steps.length === 0) {
        return {
            dimension,
            actual,
            limit,
            affectedStopCount: 0,
            affectedPackageIds: [],
        };
    }

    let crossingIndex = -1;
    steps.forEach((step, i) => {
        if (crossingIndex === -1 && cumulativeAt(step, i + 1) > limit) {
            crossingIndex = i;
        }
    });

    // The aggregate said this breached, but per-step reconstruction did not
    // find where — a rounding difference between the two derivations at the
    // margin. Reporting the last step rather than nothing keeps the count
    // conservative (at least one package flagged) instead of silently zero.
    const from = crossingIndex === -1 ? steps.length - 1 : crossingIndex;
    const affected = steps.slice(from);

    return {
        dimension,
        actual,
        limit,
        affectedStopCount: affected.length,
        affectedPackageIds: affected.map((s) => s.packageId),
    };
}
