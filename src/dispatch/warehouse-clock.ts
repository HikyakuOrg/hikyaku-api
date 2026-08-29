/**
 * Warehouse-local calendar arithmetic.
 *
 * A shift belongs to a service day at a depot, not to a UTC date, and the two
 * disagree for most of the world for part of every day. The scheduler used to
 * answer this with a PostGIS point-in-polygon join cached in the Node process;
 * since AssignmentBookkeeping the timezone is a column on `warehouse`, and all
 * that is left is turning it into a date and a day boundary.
 *
 * Pure, so the edge cases that actually bite — a half-hour offset, a DST
 * boundary, an unknown zone — are table tests rather than a deployment.
 */

/** Fallback when a warehouse has no usable timezone. */
const FALLBACK_TZ = 'UTC';

function safeZone(timeZone: string | null | undefined): string {
    if (!timeZone) return FALLBACK_TZ;
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
        return timeZone;
    } catch {
        // An unknown IANA name would otherwise throw on every package created at
        // that warehouse. UTC gives a wrong-but-working service day; a 500 gives
        // nothing at all.
        return FALLBACK_TZ;
    }
}

/** The local calendar date at `timeZone`, as YYYY-MM-DD. */
export function localShiftDate(at: Date, timeZone: string | null | undefined): string {
    // en-CA formats as YYYY-MM-DD, which is also what a Postgres ::date cast
    // wants.
    return new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(timeZone) }).format(at);
}

/**
 * The zone's UTC offset at `at`, as the "+11:00" / "-05:30" suffix a date-time
 * string can be parsed with. Resolved at the instant given, so DST is handled by
 * asking rather than by arithmetic.
 */
export function utcOffsetSuffix(at: Date, timeZone: string | null | undefined): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: safeZone(timeZone),
        timeZoneName: 'longOffset',
    }).formatToParts(at);

    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    // longOffset yields 'GMT+11:00', or a bare 'GMT' at zero offset.
    const offset = name.replace('GMT', '');
    return offset === '' ? '+00:00' : offset;
}

/**
 * Last instant of the local service day containing `at`, as epoch ms.
 *
 * This is the boundary that decides whether a deadline is binding on today's
 * route. A package promised for tomorrow is not late if it rides tomorrow — and
 * that is exactly what makes it a legitimate eviction candidate today.
 */
export function endOfLocalDayMs(at: Date, timeZone: string | null | undefined): number {
    const date = localShiftDate(at, timeZone);
    const offset = utcOffsetSuffix(at, timeZone);
    return Date.parse(`${date}T23:59:59.999${offset}`);
}

/**
 * A given local hour on the local service day containing `at`, as epoch ms.
 * Used for the default departure of a shift whose scheduled_start is unset.
 */
export function localHourMs(
    at: Date,
    timeZone: string | null | undefined,
    hour: number,
): number {
    const date = localShiftDate(at, timeZone);
    const offset = utcOffsetSuffix(at, timeZone);
    const hh = String(hour).padStart(2, '0');
    return Date.parse(`${date}T${hh}:00:00.000${offset}`);
}
