/**
 * How does automatic assignment behave for this organisation?
 *
 * Each organisation's answer lives in `organisation_dispatch_settings` and is
 * changed from Settings > Dispatch in the web dashboard. Until
 * CreateOrganisationDispatchSettings1789693200000 the same three answers were
 * process-wide environment variables (ASSIGNMENT_MODE, LOAD_SPREAD_ENABLED and
 * SERVICE_AREA_MATCHING), so every tenant a deployment served got the same one,
 * and turning a feature on for a pilot organisation turned it on for everybody.
 *
 * Read once per assignment, at the start, and carried from there, so a setting
 * saved while a package is being placed takes effect on the next package
 * rather than halfway through this one. There is no cache: the read is a
 * primary-key lookup, and a cache would mean a saved setting did not apply to
 * the very next package, which is the first thing anybody checks.
 */

// ── The executor seam ────────────────────────────────────────────────────────

/** The only thing this module needs from TypeORM. See CoverageQueryExecutor. */
export interface DispatchSettingsQueryExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

// ── Plain data ───────────────────────────────────────────────────────────────

/**
 * `instant` places a package on a shift inside the request that creates it.
 * `manual` switches that off: new packages stay PENDING until a dispatcher
 * assigns them by hand. `manual` is the old ASSIGNMENT_MODE=nightly under an
 * honest name, since there is no nightly scheduler left to pick them up.
 */
export type AssignmentMode = 'instant' | 'manual';

export interface DispatchSettings {
    /** See `AssignmentMode`. Checked before anything else is read. */
    assignmentMode: AssignmentMode;
    /**
     * Whether chooseBest charges a shift for the stops it already carries.
     *
     * On by default: spreading is the fix for one driver carrying the whole
     * metro while a colleague's van sits empty. Off restores the old
     * bin-packer, and that is the lever to pull if an organisation's shift
     * billing or total driving distance moves the wrong way, since looser
     * routes burn the 12h window faster and can push a package onto a newly
     * opened, billed shift. The penalty itself, and what it costs in both
     * directions, is LOAD_SPREAD_SECONDS_PER_STOP in insertion.ts.
     */
    loadSpread: boolean;
    /**
     * Whether a package prefers a driver whose territory covers its address.
     *
     * OFF BY DEFAULT, unlike `loadSpread`, and the asymmetry is the point.
     * Load spreading changes which of several correct answers is picked;
     * service area matching changes which drivers are eligible at all, on a
     * map (`service_areas`, `driver_service_area`) the organisation draws
     * itself, so it is switched on by that organisation once the map is
     * finished rather than by anybody else on its behalf. See
     * docs/service-area-rollout.md for how to tell when it is.
     *
     * OFF MEANS THE TERRITORY TABLES ARE NOT READ, not that their answer is
     * ignored: see AssignmentService.coverageForPoints, and
     * `allDriversAsFloaters` in coverage.ts for why the synthesized answer is
     * "everyone is a floater" rather than "nobody covers anything".
     */
    serviceAreaMatching: boolean;
}

/**
 * What an organisation that has never saved its settings runs on, which are
 * the old env defaults.
 *
 * MUST MATCH the DEFAULT clauses in
 * 1789693200000-create_organisation_dispatch_settings.sql, since a row written
 * without a value takes those and an absent row takes these;
 * dispatch-settings.spec.ts reads that file and fails if they part. The web
 * dashboard's lib/dispatch-settings.ts carries a third copy, for rendering an
 * organisation with no row.
 */
export const DEFAULT_DISPATCH_SETTINGS: Readonly<DispatchSettings> =
    Object.freeze({
        assignmentMode: 'instant',
        loadSpread: true,
        serviceAreaMatching: false,
    });

// ── The query ────────────────────────────────────────────────────────────────

/**
 * Explicitly org-scoped, like every read this API makes over the service_role
 * connection: RLS does not apply to it, so the predicate is the tenancy.
 */
export const DISPATCH_SETTINGS_SQL = `SELECT assignment_mode,
       load_spread_enabled,
       service_area_matching
  FROM organisation_dispatch_settings
 WHERE organisation_id = $1`;

interface DispatchSettingsRow {
    assignment_mode: string;
    load_spread_enabled: boolean;
    service_area_matching: boolean;
}

/**
 * This organisation's settings, or the defaults when it has never saved any.
 *
 * Throws when the query does. Callers that must not fail on it decide for
 * themselves what failing means: assignment defers the package, because
 * guessing the defaults could auto-assign for an organisation that chose
 * `manual`, while a dispatcher's pin carries on without its out-of-area
 * warning.
 */
export async function resolveDispatchSettings(
    executor: DispatchSettingsQueryExecutor,
    organisationId: string,
): Promise<DispatchSettings> {
    const rows = (await executor.query(DISPATCH_SETTINGS_SQL, [
        organisationId,
    ])) as DispatchSettingsRow[];
    const row = rows[0];
    return row ? toDispatchSettings(row) : { ...DEFAULT_DISPATCH_SETTINGS };
}

/**
 * The CHECK constraint already limits assignment_mode to the two values; the
 * comparison is still one-sided so that anything unexpected reads as
 * `instant`, the default, rather than as automatic assignment quietly
 * switching itself off.
 */
function toDispatchSettings(row: DispatchSettingsRow): DispatchSettings {
    return {
        assignmentMode: row.assignment_mode === 'manual' ? 'manual' : 'instant',
        loadSpread: row.load_spread_enabled,
        serviceAreaMatching: row.service_area_matching,
    };
}
