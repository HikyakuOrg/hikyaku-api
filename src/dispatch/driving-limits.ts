/**
 * What are this driver's driving limits?
 *
 * One question, one implementation, called from both dispatch tiers (Tier 1's
 * feasibility gate and Tier 2's VROOM vehicle) and from the shift read path
 * that shows a dispatcher "8.2h of 10h". All three must agree on what a
 * driver's limits are, so there is exactly one resolution rule here rather
 * than three copies of "check the driver's profile, then the org default".
 *
 * Same split as coverage.ts and insertion.ts: everything decidable without a
 * database is a pure function over plain objects, testable as a table of
 * inputs and expected outputs, and the I/O is one narrow, explicitly typed
 * seam. Read coverage.ts's header for why that split matters here too.
 */

// ── The executor seam ────────────────────────────────────────────────────────

/** The only thing this module needs from TypeORM. See CoverageQueryExecutor. */
export interface DrivingLimitsQueryExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

// ── Plain data ───────────────────────────────────────────────────────────────

/**
 * The four resolved limits, in their storage units — seconds and metres.
 * Nothing here converts anything; kilometres exist only where a dispatcher
 * reads or types them. Each dimension is independently nullable: null means
 * no limit on that dimension, whether because nobody set one or because
 * DRIVING_LIMITS is off.
 */
export interface DrivingLimits {
    maxWorkingSeconds: number | null;
    maxDrivingSeconds: number | null;
    maxDistanceM: number | null;
    maxStops: number | null;
}

/**
 * No limit on any dimension. Byte-identical to what the real query returns
 * for a driver with no profile in an org with no default, which is exactly
 * why it is also the disabled answer — see `noLimitsForDrivers`.
 */
export const NO_LIMITS: DrivingLimits = Object.freeze({
    maxWorkingSeconds: null,
    maxDrivingSeconds: null,
    maxDistanceM: null,
    maxStops: null,
});

/**
 * Is DRIVING_LIMITS switched on for this process?
 *
 * Read per call, never cached, so the switch works without a restart.
 * Generous in the on direction only (`on`, `true`, `1`), matching
 * SERVICE_AREA_MATCHING: the failure mode of a typo is then "the feature
 * stayed off", which is the safe one.
 */
export function drivingLimitsEnabled(): boolean {
    const flag = process.env.DRIVING_LIMITS;
    return flag === 'on' || flag === 'true' || flag === '1';
}

/**
 * The answer when DRIVING_LIMITS is off: no limits on any dimension, for
 * every driver, with no query at all.
 *
 * Unlike coverage's disabled path (`allDriversAsFloaters`), which still reads
 * `drivers` because the answer depends on which drivers exist, this one does
 * not: "no limits" does not depend on anything about the driver, so there is
 * nothing to look up. Turning the flag off has to mean the profile tables are
 * not read, full stop — see the parent epic's rollout section.
 */
export function noLimitsForDrivers(
    driverIds: readonly string[],
): Map<string, DrivingLimits> {
    return new Map(driverIds.map((id) => [id, NO_LIMITS]));
}

/**
 * One profile's four limits, before resolution. Shared shape for both halves
 * of the fallback. A driver or org with no linked profile at all reads
 * identically to one whose profile has every column null — see
 * `resolveLimits`, which only ever asks each field individually, never
 * whether the object as a whole is "a real profile".
 */
interface LimitValues {
    maxWorkingSeconds: number | null;
    maxDrivingSeconds: number | null;
    maxDistanceM: number | null;
    maxStops: number | null;
}

/** One row as the SQL below returns it, after shape checking. */
interface DrivingLimitsRow {
    driverId: string;
    driverProfile: LimitValues;
    orgDefaultProfile: LimitValues;
}

// ── The resolution rule ──────────────────────────────────────────────────────

/**
 * Most specific wins, PER DIMENSION, not per profile.
 *
 * A driver profile that sets only `maxDistanceM` inherits the org default's
 * `maxWorkingSeconds` rather than dropping it — that is the whole point of
 * resolving dimension by dimension instead of picking one profile object and
 * using it wholesale. `??` rather than `||`: every real value here is
 * constrained `> 0` by the database, so the only thing `??` treats
 * differently from `||` is a value that cannot occur, but `??` is the
 * operator that is actually correct for "null means unset", and says so to a
 * reader without relying on the constraint holding.
 *
 * Pure, and the ONLY place the resolution order is written down.
 */
export function resolveLimits(
    driverProfile: LimitValues,
    orgDefaultProfile: LimitValues,
): DrivingLimits {
    return {
        maxWorkingSeconds:
            driverProfile.maxWorkingSeconds ??
            orgDefaultProfile.maxWorkingSeconds ??
            null,
        maxDrivingSeconds:
            driverProfile.maxDrivingSeconds ??
            orgDefaultProfile.maxDrivingSeconds ??
            null,
        maxDistanceM:
            driverProfile.maxDistanceM ??
            orgDefaultProfile.maxDistanceM ??
            null,
        maxStops: driverProfile.maxStops ?? orgDefaultProfile.maxStops ?? null,
    };
}

// ── The query ────────────────────────────────────────────────────────────────

/**
 * $1 organisation id, $2 driver ids.
 *
 * One row per input driver id, guaranteed by driving from `unnest($2)` rather
 * than from `drivers`: a driver id that does not exist, or belongs to another
 * organisation (the `d.organisation_id = $1` join condition), simply LEFT
 * JOINs to nulls and resolves to NO_LIMITS rather than disappearing from the
 * result — the same "always the same length" contract coverage.ts's batch
 * queries make, adapted to a driver-keyed answer instead of a point-indexed
 * one, since driver ids (unlike coordinate pairs) are already a natural
 * unique key and need no ordinality trick to stay aligned.
 *
 * The org default is resolved once, in its own CTE, and cross-joined onto
 * every input row rather than re-looked-up per driver: it is the same value
 * for the whole call regardless of how many drivers are asked about.
 *
 * `is_deleted = false` on both profile joins is spelled out because nothing
 * in the database will do it: soft delete is filtered in the query layer and
 * never in RLS, matching every other soft-deleted table in this schema. A
 * driver or an org pointing at a since-deleted profile falls back to the next
 * link in the chain (org default, then no limit) rather than resolving a
 * retired policy.
 */
export const DRIVING_LIMITS_SQL = `
WITH input_drivers AS (
    SELECT driver_id FROM unnest($2::uuid[]) AS t(driver_id)
),
org_default AS (
    SELECT dlp.max_working_seconds,
           dlp.max_driving_seconds,
           dlp.max_distance_m,
           dlp.max_stops
      FROM organisations o
      JOIN driving_limit_profile dlp
        ON dlp.id = o.default_driving_limit_profile_id
       AND dlp.is_deleted = false
     WHERE o.id = $1::uuid
)
SELECT idr.driver_id,
       dp.max_working_seconds AS driver_max_working_seconds,
       dp.max_driving_seconds AS driver_max_driving_seconds,
       dp.max_distance_m      AS driver_max_distance_m,
       dp.max_stops           AS driver_max_stops,
       od.max_working_seconds AS org_max_working_seconds,
       od.max_driving_seconds AS org_max_driving_seconds,
       od.max_distance_m      AS org_max_distance_m,
       od.max_stops           AS org_max_stops
  FROM input_drivers idr
  LEFT JOIN drivers d
    ON  d.id = idr.driver_id
    AND d.organisation_id = $1::uuid
  LEFT JOIN driving_limit_profile dp
    ON  dp.id = d.driving_limit_profile_id
    AND dp.is_deleted = false
  LEFT JOIN org_default od ON true
`;

// ── Entry points ─────────────────────────────────────────────────────────────

/**
 * Every driver's effective limits, in ONE round trip.
 *
 * The batch form exists for the same reason `coveringDriversForPoints`'s
 * does: a 500-package import resolving candidate shifts across many drivers
 * must not become one profile lookup per driver. Callers that already know
 * which drivers they are about to consider (Tier 1's loaded candidates, a
 * shift list) resolve them all here and read the map afterwards.
 *
 * Returns one entry per DISTINCT input driver id. An empty `driverIds` never
 * touches the database.
 */
export async function resolveDrivingLimitsForDrivers(
    executor: DrivingLimitsQueryExecutor,
    organisationId: string,
    driverIds: readonly string[],
): Promise<Map<string, DrivingLimits>> {
    const distinctIds = [...new Set(driverIds)];
    if (distinctIds.length === 0) return new Map();

    const rows = parseDrivingLimitsRows(
        await executor.query(DRIVING_LIMITS_SQL, [organisationId, distinctIds]),
    );

    const result = new Map<string, DrivingLimits>();
    for (const row of rows) {
        result.set(
            row.driverId,
            resolveLimits(row.driverProfile, row.orgDefaultProfile),
        );
    }
    return result;
}

/**
 * One driver's effective limits.
 *
 * A wrapper over the batch form, NOT a second query, for the same reason
 * `coveringDriversForPoint` is one: every caller resolving a single shift
 * must answer with exactly the same rule a batch resolution would have given
 * it.
 */
export async function resolveDrivingLimitsForDriver(
    executor: DrivingLimitsQueryExecutor,
    organisationId: string,
    driverId: string,
): Promise<DrivingLimits> {
    const limits = await resolveDrivingLimitsForDrivers(
        executor,
        organisationId,
        [driverId],
    );
    const forDriver = limits.get(driverId);
    // resolveDrivingLimitsForDrivers returns exactly one entry per distinct
    // input id, so this is total. The throw is here so a future edit that
    // breaks that invariant fails loudly instead of returning undefined into
    // a caller typed to receive a DrivingLimits.
    if (!forDriver) {
        throw new Error(
            `Driving limits query returned no entry for driver ${driverId}.`,
        );
    }
    return forDriver;
}

/**
 * One driver's effective limits, or NO_LIMITS with no query at all when
 * DRIVING_LIMITS is off or the caller has no driver yet (an unopened shift,
 * a row still being loaded).
 *
 * The gate every caller across both tiers should go through rather than
 * hand-rolling `!driverId || !drivingLimitsEnabled()` themselves — three
 * near-identical copies of that check is exactly the kind of drift this
 * module's own header warns against.
 */
export async function driverLimitsOrDefault(
    executor: DrivingLimitsQueryExecutor,
    organisationId: string,
    driverId: string | null,
): Promise<DrivingLimits> {
    if (!driverId || !drivingLimitsEnabled()) return NO_LIMITS;
    return resolveDrivingLimitsForDriver(executor, organisationId, driverId);
}

/**
 * Every listed driver's effective limits, in one round trip, or NO_LIMITS
 * for all of them with no query when DRIVING_LIMITS is off. The batch
 * counterpart to `driverLimitsOrDefault`.
 */
export async function driverLimitsOrDefaultForDrivers(
    executor: DrivingLimitsQueryExecutor,
    organisationId: string,
    driverIds: readonly string[],
): Promise<Map<string, DrivingLimits>> {
    if (!drivingLimitsEnabled()) return noLimitsForDrivers(driverIds);
    return resolveDrivingLimitsForDrivers(executor, organisationId, driverIds);
}

// ── Tier 2: VROOM ────────────────────────────────────────────────────────────

/** The VROOM vehicle fields a driver's limits translate to. */
export interface VroomVehicleLimits {
    time_window: [number, number];
    max_travel_time?: number;
    max_distance?: number;
    max_tasks?: number;
}

/**
 * How a driver's limits bind on a VROOM vehicle, given the window it would
 * otherwise get (normally `[setOff, setOff + SHIFT_WINDOW_SECONDS]`).
 *
 * `maxDrivingSeconds` -> `max_travel_time`, NOT the working-time limit despite
 * the tempting name: VROOM's `max_travel_time` counts travel only. Service,
 * setup, waiting and break durations are excluded — VROOM accumulates those
 * separately, in a field this limit never sees. There is no VROOM field for
 * working time in any released version; the maintainer's own documented
 * workaround for it is the vehicle `time_window`, which is what
 * `maxWorkingSeconds` narrows below. Getting the two backwards would let a
 * driver's actual on-road time run past their working-time cap.
 *
 * `maxWorkingSeconds` narrows `time_window`'s end, never widens it — same
 * rule Tier 1's `cheapestPosition` applies to its own copy of this window
 * (see SHIFT_WINDOW_SECONDS in insertion.ts). The window itself is never
 * dropped to express "no limit": VROOM needs SOME time_window present for
 * `step.arrival` to report absolute epoch seconds, which every caller here
 * already depends on.
 *
 * `maxDistanceM` -> `max_distance`, unconverted: both are already metres.
 * The profile stores metres and VROOM's field takes metres — no conversion
 * belongs on this path, the same rule that keeps `vehicle_gross_limits`
 * (kilograms) and job `amount` (grams) from ever silently colliding.
 *
 * `maxStops` -> `max_tasks`: a job counts 1 towards it; this fleet sends no
 * breaks, so there is nothing else on a route that could.
 *
 * A null limit on any dimension omits that VROOM field entirely, which is
 * VROOM's own spelling of "no limit" — so a fully-null `limits` produces
 * byte-for-byte today's request, just the `time_window` unchanged.
 */
export function vroomVehicleLimits(
    limits: DrivingLimits,
    window: readonly [number, number],
): VroomVehicleLimits {
    const [start, end] = window;
    const result: VroomVehicleLimits = {
        time_window:
            limits.maxWorkingSeconds != null
                ? [start, Math.min(end, start + limits.maxWorkingSeconds)]
                : [start, end],
    };
    if (limits.maxDrivingSeconds != null) {
        result.max_travel_time = limits.maxDrivingSeconds;
    }
    if (limits.maxDistanceM != null) {
        result.max_distance = limits.maxDistanceM;
    }
    if (limits.maxStops != null) {
        result.max_tasks = limits.maxStops;
    }
    return result;
}

// ── Row shape checking ───────────────────────────────────────────────────────

/** Reads one nullable numeric column, coercing a text-mode driver's string back to a number. */
function readNullableNumber(value: unknown, columnName: string): number | null {
    if (value === null || value === undefined) return null;
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) {
        throw new TypeError(
            `Driving limits row has a non-numeric ${columnName} ` +
                `(${JSON.stringify(value) ?? 'undefined'}).`,
        );
    }
    return asNumber;
}

/**
 * Narrows what the pg driver handed back into `DrivingLimitsRow[]`.
 *
 * A driver or org with no linked profile comes back with every `*_max_*`
 * column null, from the LEFT JOINs. That reads as an all-null LimitValues
 * object, not a null one — see the comment on LimitValues for why
 * `resolveLimits` cannot tell the two apart anyway, and does not need to.
 *
 * Throws rather than dropping a row it does not recognise: a result that
 * does not look like this one means the query and this file have drifted
 * apart, and silently dropping a driver would resolve them to NO_LIMITS by
 * omission — the one wrong answer a caller enforcing a cap must never get
 * from a parsing bug.
 *
 * Pure, and unit tested with no database.
 */
export function parseDrivingLimitsRows(raw: unknown): DrivingLimitsRow[] {
    if (!Array.isArray(raw)) {
        throw new TypeError(
            `Driving limits query returned ${typeof raw}, expected an array of rows.`,
        );
    }

    return raw.map((entry: unknown, index: number): DrivingLimitsRow => {
        if (typeof entry !== 'object' || entry === null) {
            throw new TypeError(
                `Driving limits row ${index} is not an object.`,
            );
        }
        const row = entry as Record<string, unknown>;

        const driverId = row.driver_id;
        if (typeof driverId !== 'string') {
            throw new TypeError(
                `Driving limits row ${index} has no driver_id (got ${typeof driverId}).`,
            );
        }

        const driverValues: LimitValues = {
            maxWorkingSeconds: readNullableNumber(
                row.driver_max_working_seconds,
                'driver_max_working_seconds',
            ),
            maxDrivingSeconds: readNullableNumber(
                row.driver_max_driving_seconds,
                'driver_max_driving_seconds',
            ),
            maxDistanceM: readNullableNumber(
                row.driver_max_distance_m,
                'driver_max_distance_m',
            ),
            maxStops: readNullableNumber(
                row.driver_max_stops,
                'driver_max_stops',
            ),
        };
        const orgValues: LimitValues = {
            maxWorkingSeconds: readNullableNumber(
                row.org_max_working_seconds,
                'org_max_working_seconds',
            ),
            maxDrivingSeconds: readNullableNumber(
                row.org_max_driving_seconds,
                'org_max_driving_seconds',
            ),
            maxDistanceM: readNullableNumber(
                row.org_max_distance_m,
                'org_max_distance_m',
            ),
            maxStops: readNullableNumber(row.org_max_stops, 'org_max_stops'),
        };

        return {
            driverId,
            driverProfile: driverValues,
            orgDefaultProfile: orgValues,
        };
    });
}
