/**
 * Every decision Tier 1 makes, as pure functions over plain objects.
 *
 * Nothing in this file touches a database, a queue or the network — that is the
 * point. The assignment rule is where the interesting mistakes live (a stop
 * pushed past its own deadline by an insertion three positions earlier; an
 * eviction cascade that starves deadline-less freight), and those are only
 * cheap to test when they are expressible as a table of inputs and expected
 * outputs. `assignment.service.ts` does the I/O and calls in here for the
 * answers.
 *
 * The estimates below are deliberately pessimistic. Tier 1 must UNDER-estimate
 * how much a van can carry: a false "infeasible" costs one extra shift, a false
 * "feasible" costs a missed customer promise. Tier 2's VROOM solve recovers the
 * slack a few seconds later with real road distances.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Straight-line speed used for haversine estimates, in m/s (~40 km/h). Urban
 * delivery average including stops at lights, not a highway cruise.
 */
export const AVG_SPEED_MPS = 11.1;

/** Road distance is longer than the crow flies. Multiplies the haversine. */
export const DETOUR_FACTOR = 1.35;

/** Tier 1's pessimism dial. Applied on top of DETOUR_FACTOR. */
export const TIER1_SAFETY = 1.2;

/**
 * How close to a deadline an estimate may land before it stops being trusted.
 * Inside this band the caller replaces the haversine estimate with one real
 * Valhalla call — the only HTTP Tier 1 ever makes, and never inside the lock.
 */
export const GREY_BAND = 0.15;

/**
 * Hard cap on job steps per shift. Time is the binding constraint long before
 * mass is (a van saturates at ~30–40 stops in a 12h window at 15 min/stop), but
 * this bounds the O(n²) insertion scan and keeps a runaway import from building
 * a 300-stop route nobody can drive.
 */
export const MAX_STOPS = 45;

/**
 * A shift closes to automatic assignment this many seconds before it sets off.
 * Nothing gets added to a van that is about to roll.
 */
export const DISPATCH_LEAD_S = 900;

/** A package older than this is pinned: it has already paid its wait. */
export const AGING_HOURS = 24;

/** A package may be bumped at most this many times, then it becomes immovable. */
export const MAX_EVICTIONS = 2;

/**
 * Service time per delivery stop, in seconds (15 minutes).
 *
 * DatabaseService re-exports this rather than declaring its own: Tier 1 deciding
 * a route fits on one number while the VROOM request is built from a different
 * one is a silent correctness bug, not a style problem.
 */
export const TIME_PER_STOP = 900;

/** Width of the vehicle operating window once it has set off, in seconds (12h). */
export const SHIFT_WINDOW_SECONDS = 12 * 60 * 60;

/**
 * Seconds of extra driving Tier 1 will accept to put a package on a van that
 * carries one fewer stop. The load-spreading dial.
 *
 * Read this one before touching it. Every other constant in this file trades
 * one estimate against another; this one trades money against service quality,
 * in both directions, and it does it silently.
 *
 * At 0 the engine is a pure bin-packer, which is what it used to be: one van
 * absorbs the whole metro while a colleague's van sits empty at the depot.
 * That is cheap in fuel and in billed shifts, and it is bad for the driver
 * holding 30 stops, for the customers at the back of that route, and for any
 * day where something goes wrong (one breakdown strands every parcel on it).
 *
 * Turned up, the fleet spreads, and the cost lands in two places. The obvious
 * one is total driving distance, since two half-full vans usually cover more
 * ground than one full one. The expensive one is indirect: looser routes burn
 * the 12h SHIFT_WINDOW_SECONDS faster, so packages stop fitting on the shifts
 * already open, and openShift() bills the organisation for another one.
 * enforce_shift_allowance() does not make that visible from here. An org with a
 * card on file is never blocked past its free monthly allowance (30 shifts for
 * a personal org, 600 for a company one), it is just billed Stripe overage,
 * quietly. An org without a card gets a hard 23514 instead and its packages go
 * `deferred`. Both directions are real regressions, so move this number with
 * measurements, not taste.
 *
 * 240 (4 minutes, about a quarter of TIME_PER_STOP) is what the synthetic metro
 * scenario in insertion.spec.ts settled on. Measured there, over a 10 km metro
 * with a shared depot: 30 packages across 3 shifts went from 30/0/0 stops and
 * 97 km to 11/11/8 stops and 114 km, so the balance costs about 18% more
 * driving at low load. At high load the same dial pays for itself, because the
 * bin-packer's one huge serpentine route wastes the window: at 120 packages on
 * the same 3 shifts it left 26 packages unplaced and drove 302 km, against 15
 * unplaced and 232 km with the penalty on. Below about 120 s/stop the penalty
 * is too weak to beat urban geography and the first van still runs away with
 * the day.
 */
export const LOAD_SPREAD_SECONDS_PER_STOP = 240;

/** Mean Earth radius in metres. */
const EARTH_RADIUS_M = 6_371_008.8;

// ── Plain data ───────────────────────────────────────────────────────────────

export interface GeoPoint {
    lon: number;
    lat: number;
}

/** One stop already on a candidate shift's route, in visiting order. */
export interface RouteStop {
    packageId: string;
    lon: number;
    lat: number;
    /** Package mass in GRAMS. Both sides of the capacity check use grams. */
    weightG: number;
    /** Customer deadline as epoch ms, or null when the package has no promise. */
    deadlineMs: number | null;
    /** Latest package_timeline status enum, e.g. 'ASSIGNED', 'IN_TRANSIT'. */
    status: string;
    evictionCount: number;
    createdAtMs: number;
}

/** A shift Tier 1 may try to insert into. */
export interface CandidateShift {
    id: string;
    /** vrp_optimization.revision at load time; re-read under the lock. */
    revision: number;
    driverId: string | null;
    vehicleId: string | null;
    /** Vehicle capacity in GRAMS (vehicle_gross_limits is kg — convert, do not round the weights). */
    capacityG: number;
    /** When the van sets off, epoch ms. */
    departureMs: number;
    /** Warehouse location; the route starts and ends here. */
    depot: GeoPoint;
    /** Existing job steps in visiting order. */
    stops: RouteStop[];
}

/** The package being placed. */
export interface IncomingPackage {
    id: string;
    lon: number;
    lat: number;
    weightG: number;
    deadlineMs: number | null;
    createdAtMs: number;
    evictionCount: number;
}

export type InsertionFailure = 'weight' | 'max_stops' | 'deadline' | 'window';

export interface InsertionSuccess {
    feasible: true;
    shiftId: string;
    /** Zero-based position among job steps the package takes. */
    index: number;
    /** Extra driving seconds the detour costs. */
    deltaSeconds: number;
    /**
     * Tightest deadline on the resulting route, as a fraction of the time
     * available to reach it. Below GREY_BAND the estimate is too close to call
     * and the caller escalates to one real routing call. Infinity when no stop
     * on the route has a binding deadline.
     */
    slackRatio: number;
    /** Arrival epoch ms per job step, in the resulting visiting order. */
    arrivalsMs: number[];
    /** The resulting visiting order, including the inserted package. */
    order: string[];
}

export interface InsertionRejection {
    feasible: false;
    shiftId: string;
    reason: InsertionFailure;
}

export type InsertionResult = InsertionSuccess | InsertionRejection;

/** Everything the pure layer needs to know about "now" and "today". */
export interface InsertionContext {
    /** Reference time, epoch ms. */
    nowMs: number;
    /**
     * End of the shift's service day in the warehouse's local timezone, epoch
     * ms. A deadline beyond this is not binding on today's route.
     */
    shiftDayEndMs: number;
    /**
     * Per-leg travel seconds measured by the router, keyed "fromLon,fromLat>toLon,toLat".
     * Populated only for a grey-band re-check; absent keys fall back to the
     * haversine estimate.
     */
    measuredLegs?: Readonly<Record<string, number>>;
}

// ── Geometry and time ────────────────────────────────────────────────────────

/** Great-circle distance between two points, in metres. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
    const toRad = Math.PI / 180;
    const lat1 = a.lat * toRad;
    const lat2 = b.lat * toRad;
    const dLat = (b.lat - a.lat) * toRad;
    const dLon = (b.lon - a.lon) * toRad;

    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cache key for a measured leg. Exported so callers can fill the map. */
export function legKey(from: GeoPoint, to: GeoPoint): string {
    return `${from.lon},${from.lat}>${to.lon},${to.lat}`;
}

/**
 * Estimated driving seconds from `from` to `to`.
 *
 * A measured leg always wins — that is what the grey-band Valhalla call buys.
 * Otherwise: haversine, inflated for road detour, divided by an urban average
 * speed, then inflated again by the safety factor.
 */
export function estimateLeg(
    from: GeoPoint,
    to: GeoPoint,
    measured?: Readonly<Record<string, number>>,
): number {
    const measuredSeconds = measured?.[legKey(from, to)];
    if (measuredSeconds != null) return measuredSeconds;

    const metres = haversineMeters(from, to) * DETOUR_FACTOR;
    return (metres / AVG_SPEED_MPS) * TIER1_SAFETY;
}

/**
 * The deadline that actually constrains today's route.
 *
 * Null in, null out. A deadline past the end of this service day is not binding
 * on it either — the package can ride tomorrow — and that is precisely what
 * makes such a package evictable.
 */
export function effectiveDeadline(
    deadlineMs: number | null,
    shiftDayEndMs: number,
): number | null {
    if (deadlineMs == null) return null;
    if (deadlineMs > shiftDayEndMs) return null;
    return deadlineMs;
}

// ── Insertion ────────────────────────────────────────────────────────────────

interface Timing {
    arrivalsMs: number[];
    returnMs: number;
    totalDriveSeconds: number;
}

/**
 * Walks a visiting order from the depot and back, returning the arrival time at
 * each stop. Service time is spent AT a stop, so it lands between arriving at
 * stop i and departing for stop i+1.
 */
function timeRoute(
    depot: GeoPoint,
    departureMs: number,
    order: readonly GeoPoint[],
    measured?: Readonly<Record<string, number>>,
): Timing {
    const arrivalsMs: number[] = [];
    let cursorMs = departureMs;
    let driveSeconds = 0;
    let previous = depot;

    for (const stop of order) {
        const leg = estimateLeg(previous, stop, measured);
        driveSeconds += leg;
        cursorMs += leg * 1000;
        arrivalsMs.push(cursorMs);
        cursorMs += TIME_PER_STOP * 1000;
        previous = stop;
    }

    const legHome = estimateLeg(previous, depot, measured);
    driveSeconds += legHome;

    return {
        arrivalsMs,
        returnMs: cursorMs + legHome * 1000,
        totalDriveSeconds: driveSeconds,
    };
}

/**
 * Arrival time at each point of a fixed visiting order, epoch ms.
 *
 * The dispatcher-override and manual-removal paths do not choose an order — a
 * human already did, or the order simply survives a deletion — but they still
 * have to rewrite every ETA on the route, because removing stop 2 moves stops
 * 3..n earlier.
 */
export function scheduleArrivals(
    depot: GeoPoint,
    departureMs: number,
    order: readonly GeoPoint[],
    measured?: Readonly<Record<string, number>>,
): number[] {
    return timeRoute(depot, departureMs, order, measured).arrivalsMs;
}

/**
 * Total drive time of a route in seconds, ignoring service and deadlines. Used
 * only to price a detour against the route the shift already has.
 */
function driveSeconds(
    depot: GeoPoint,
    order: readonly GeoPoint[],
    measured?: Readonly<Record<string, number>>,
): number {
    let total = 0;
    let previous = depot;
    for (const stop of order) {
        total += estimateLeg(previous, stop, measured);
        previous = stop;
    }
    return total + estimateLeg(previous, depot, measured);
}

/**
 * Cheapest feasible position for `pkg` on `shift`, or a rejection.
 *
 * Every position is tried, not just append. Appending is usually the worst
 * choice — a stop that sits between two existing ones costs almost nothing,
 * while bolting it onto the end costs a return leg twice. Feasibility is
 * re-checked for the WHOLE resulting route at each position, because splicing a
 * stop in at position 2 delays every stop after it, and one of those may be the
 * one that breaks.
 */
export function cheapestPosition(
    shift: CandidateShift,
    pkg: IncomingPackage,
    ctx: InsertionContext,
): InsertionResult {
    const measured = ctx.measuredLegs;
    const incoming: GeoPoint = { lon: pkg.lon, lat: pkg.lat };
    const baseline = driveSeconds(shift.depot, shift.stops, measured);
    const windowEndMs = shift.departureMs + SHIFT_WINDOW_SECONDS * 1000;

    let best: InsertionSuccess | null = null;
    // A rejection is only reported once every position has failed, and the last
    // reason seen is the most informative: 'window' beats 'deadline' only if
    // nothing ever got as far as a deadline check.
    let worstReason: InsertionFailure = 'deadline';

    for (let index = 0; index <= shift.stops.length; index++) {
        const points: GeoPoint[] = [];
        const ids: string[] = [];
        const deadlines: (number | null)[] = [];

        for (let i = 0; i <= shift.stops.length; i++) {
            if (i === index) {
                points.push(incoming);
                ids.push(pkg.id);
                deadlines.push(
                    effectiveDeadline(pkg.deadlineMs, ctx.shiftDayEndMs),
                );
            }
            const stop = shift.stops[i];
            if (stop) {
                points.push({ lon: stop.lon, lat: stop.lat });
                ids.push(stop.packageId);
                deadlines.push(
                    effectiveDeadline(stop.deadlineMs, ctx.shiftDayEndMs),
                );
            }
        }

        const timing = timeRoute(
            shift.depot,
            shift.departureMs,
            points,
            measured,
        );

        if (timing.returnMs > windowEndMs) {
            worstReason = 'window';
            continue;
        }

        let breached = false;
        let slackRatio = Number.POSITIVE_INFINITY;

        for (let i = 0; i < deadlines.length; i++) {
            const deadline = deadlines[i];
            if (deadline == null) continue;
            const arrival = timing.arrivalsMs[i];
            if (arrival > deadline) {
                breached = true;
                break;
            }
            // Budget is the whole time available from departure to the promise;
            // slack as a fraction of it is what "within 15% of a deadline" means.
            const budget = Math.max(deadline - shift.departureMs, 1);
            slackRatio = Math.min(slackRatio, (deadline - arrival) / budget);
        }

        if (breached) {
            worstReason = 'deadline';
            continue;
        }

        const deltaSeconds = timing.totalDriveSeconds - baseline;
        if (best === null || deltaSeconds < best.deltaSeconds) {
            best = {
                feasible: true,
                shiftId: shift.id,
                index,
                deltaSeconds,
                slackRatio,
                arrivalsMs: timing.arrivalsMs,
                order: ids,
            };
        }
    }

    return best ?? { feasible: false, shiftId: shift.id, reason: worstReason };
}

/**
 * Can this package go on this shift, and where?
 *
 * Gates run cheapest-first: mass, then stop count, then the O(n) × O(n) timing
 * scan. Weight is checked in GRAMS on both sides — the existing optimiser
 * compares a capacity in kilograms against amounts in grams, which makes a
 * 1000 kg van report 1 kg of capacity.
 */
export function tryInsert(
    shift: CandidateShift,
    pkg: IncomingPackage,
    ctx: InsertionContext,
): InsertionResult {
    const loadG = shift.stops.reduce((sum, stop) => sum + stop.weightG, 0);
    if (loadG + pkg.weightG > shift.capacityG) {
        return { feasible: false, shiftId: shift.id, reason: 'weight' };
    }

    if (shift.stops.length + 1 > MAX_STOPS) {
        return { feasible: false, shiftId: shift.id, reason: 'max_stops' };
    }

    return cheapestPosition(shift, pkg, ctx);
}

/** True when the estimate landed too close to a promise to be trusted. */
export function isGreyBand(result: InsertionResult): boolean {
    return result.feasible && result.slackRatio < GREY_BAND;
}

/**
 * What a shift's existing load is worth in imaginary detour seconds, to be
 * charged on top of a candidate's real detour before shifts are compared.
 *
 * Linear on purpose. The comparison only ever sees the DIFFERENCE between two
 * shifts, and for a linear penalty that difference is
 * LOAD_SPREAD_SECONDS_PER_STOP times the gap in their stop counts: the
 * correction is proportional to how lopsided the two vans already are, and it
 * vanishes when they are level. A curve that grows faster than linear was tried
 * and is worse exactly where it matters, because it is nearly flat over the
 * first handful of stops, which is the window in which the first van runs away
 * with the whole day's work.
 *
 * This is a soft preference, not a rule. It reorders candidates, it never makes
 * an insertion infeasible, and a fuller van that is genuinely much closer still
 * wins. At MAX_STOPS it is 10800 s, which is large enough to outweigh any
 * detour a 12h window can hold, so a saturated van is only chosen when it is
 * the sole feasible option.
 */
export function loadPenaltySeconds(stops: number): number {
    return Math.max(0, stops) * LOAD_SPREAD_SECONDS_PER_STOP;
}

/**
 * Picks the winner among feasible insertions.
 *
 * Cheapest first, where the cost of a candidate is its real detour plus
 * loadPenaltySeconds for how full that shift already is. Then the EMPTIER
 * shift. Then the id, so a tie is resolved the same way twice and tests are
 * deterministic.
 *
 * Both of those used to run the other way round, deliberately: the fuller shift
 * won, because packing tight keeps the number of shifts down and every new
 * shift bills. It kept the count down by handing one driver 20+ stops across
 * the whole metro while a colleague idled at the depot. See
 * LOAD_SPREAD_SECONDS_PER_STOP for what that trade is worth in both directions.
 *
 * `spreadLoad` defaults to on; AssignmentService passes its LOAD_SPREAD_ENABLED
 * reading through so the penalty can be switched off mid-incident without a
 * deploy. The tie-break stays flipped either way. It only fires on an exact
 * equality of detour seconds, which is rare with float haversine estimates, and
 * it can only ever move a package between shifts that already exist, so unlike
 * the penalty it cannot bill anybody anything.
 */
export function chooseBest(
    results: readonly InsertionResult[],
    stopCounts: Readonly<Record<string, number>>,
    opts: { spreadLoad?: boolean } = {},
): InsertionSuccess | null {
    const spreadLoad = opts.spreadLoad ?? true;
    // deltaSeconds on the result stays the honest detour; the penalty is only
    // ever applied here, for the comparison.
    const cost = (result: InsertionSuccess): number =>
        result.deltaSeconds +
        (spreadLoad ? loadPenaltySeconds(stopCounts[result.shiftId] ?? 0) : 0);

    const feasible = results.filter((r): r is InsertionSuccess => r.feasible);
    if (feasible.length === 0) return null;

    return feasible.reduce((best, candidate) => {
        const candidateCost = cost(candidate);
        const bestCost = cost(best);
        if (candidateCost !== bestCost) {
            return candidateCost < bestCost ? candidate : best;
        }
        const candidateStops = stopCounts[candidate.shiftId] ?? 0;
        const bestStops = stopCounts[best.shiftId] ?? 0;
        if (candidateStops !== bestStops) {
            return candidateStops < bestStops ? candidate : best;
        }
        return candidate.shiftId < best.shiftId ? candidate : best;
    });
}

// ── Eviction ─────────────────────────────────────────────────────────────────

export interface EvictionPlan {
    /** In the order they were removed. Usually one, never more than needed. */
    victimIds: string[];
    /** Where the incoming package lands once the victims are gone. */
    insertion: InsertionSuccess;
}

/**
 * Is this stop allowed to be bumped?
 *
 * Four conditions, and all four matter:
 *   - it is merely ASSIGNED. A package the driver has loaded or is carrying is
 *     physically on the van; removing it from the plan does not remove it from
 *     the vehicle.
 *   - it has no deadline binding on this service day. Bumping a promise to keep
 *     a promise is not progress.
 *   - it has been bumped fewer than MAX_EVICTIONS times.
 *   - it is younger than AGING_HOURS. An older package has already waited; it
 *     stops being fair game.
 *
 * The last two together are what make the rule bounded: any package becomes
 * immovable after two bumps or one day, whichever comes first, so no package can
 * be deferred indefinitely by a warehouse with steady deadline traffic.
 */
export function isEvictable(stop: RouteStop, ctx: InsertionContext): boolean {
    if (stop.status !== 'ASSIGNED') return false;
    if (effectiveDeadline(stop.deadlineMs, ctx.shiftDayEndMs) !== null)
        return false;
    if (stop.evictionCount >= MAX_EVICTIONS) return false;
    if (stop.createdAtMs <= ctx.nowMs - AGING_HOURS * 3_600_000) return false;
    return true;
}

/**
 * The minimum set of packages to bump so `pkg` fits on `shift`, or null.
 *
 * Last resort only: the caller must have failed to place the package on any
 * existing shift AND failed to open a new one first.
 *
 * Victims are taken NEWEST first among the evictable set (after preferring the
 * least-bumped), because an older package has already paid its wait — bumping it
 * again compounds a delay the customer is already living with. They are removed
 * one at a time and the insertion is re-tried after each, so a package that fits
 * after one eviction never costs two.
 */
export function pickVictims(
    shift: CandidateShift,
    pkg: IncomingPackage,
    ctx: InsertionContext,
): EvictionPlan | null {
    // The thrash guard: a package with nothing promised has no claim on someone
    // else's slot. Without this, a steady stream of deadline-less parcels would
    // bump each other in circles.
    if (effectiveDeadline(pkg.deadlineMs, ctx.shiftDayEndMs) === null)
        return null;

    const candidates = shift.stops
        .filter((stop) => isEvictable(stop, ctx))
        .sort((a, b) => {
            if (a.evictionCount !== b.evictionCount) {
                return a.evictionCount - b.evictionCount;
            }
            if (a.createdAtMs !== b.createdAtMs)
                return b.createdAtMs - a.createdAtMs;
            return a.packageId < b.packageId ? -1 : 1;
        });

    if (candidates.length === 0) return null;

    const victimIds: string[] = [];
    let remaining = shift.stops;

    for (const victim of candidates) {
        victimIds.push(victim.packageId);
        remaining = remaining.filter((s) => s.packageId !== victim.packageId);

        const attempt = tryInsert({ ...shift, stops: remaining }, pkg, ctx);
        if (attempt.feasible) {
            return { victimIds, insertion: attempt };
        }
    }

    return null;
}
