import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import {
    COVERAGE_OUTCOMES,
    FALLBACK_OUTCOMES,
    type CoverageOutcome,
} from './coverage';

/**
 * How long counts are accumulated in memory before one rolled-up point per
 * organisation is emitted.
 *
 * NOT a sampling interval: nothing is dropped, the values sent are sums over
 * the window. See the class comment for why the aggregation exists at all.
 * A minute is short enough that a bad rollout is visible while somebody is
 * still watching the deploy, and long enough that a warehouse pushing a
 * thousand packages an hour still produces a handful of points rather than a
 * thousand.
 */
const FLUSH_INTERVAL_MS = 60_000;

/**
 * The fallback rate above which an organisation's coverage configuration is
 * reported as a problem: more than one package in five going to a driver who
 * does not work that area.
 *
 * Chosen rather than derived, and worth saying so plainly: there is no
 * historical data to fit a threshold to, because the feature has never run.
 * The reasoning is that steps 3 and 4 are a legitimate outcome on a busy
 * afternoon (the covering driver is genuinely full, and the package still has
 * to go somewhere), so a low single-digit rate is health, not failure. A
 * sustained fifth of all traffic is a different shape of problem: at that level
 * the map is wrong, not the day. Tune it once there are two weeks of real
 * numbers; it is deliberately one constant in one place so that is a one-line
 * change.
 */
const FALLBACK_RATE_ALERT_THRESHOLD = 0.2;

/**
 * How many coverage decisions an organisation must make in a window before its
 * fallback rate is allowed to raise anything.
 *
 * Without this, a depot that assigned three packages and sent one to a
 * non-covering driver alerts at 33%, which is noise: the rate is a ratio and a
 * ratio over a handful of samples says nothing. Twenty is roughly a small
 * depot's morning.
 */
const MIN_DECISIONS_BEFORE_ALERT = 20;

/** One organisation's counts since the last flush. */
export interface OrgWindow {
    outcomes: Map<CoverageOutcome, number>;
    /** New shifts opened, keyed by which step of the assignment order did it. */
    shiftsOpened: Map<2 | 4, number>;
}

/** The rolled-up shape a flush emits and the alert rule reads. */
export interface CoverageWindowSummary {
    organisationId: string;
    /** Counts for all five outcomes, zeros included. */
    outcomes: Record<CoverageOutcome, number>;
    /** Coverage decisions actually taken: everything except `disabled`. */
    decisions: number;
    /** Of those, the ones that went to a driver who does not cover the point. */
    fallbacks: number;
    shiftsOpenedAtStep2: number;
    shiftsOpenedAtStep4: number;
}

/**
 * What the coverage rollout looks like from outside, in numbers.
 *
 * ── WHY THIS AGGREGATES INSTEAD OF EMITTING PER PACKAGE ──────────────────────
 *
 * The obvious implementation is one `Sentry.metrics.count(..., 1)` per
 * assignment, tagged with the organisation. That is one metric item per
 * package, every package, forever, each carrying an organisation id as an
 * attribute — and organisation id is unbounded, one new value per customer
 * signed. Whether that is affordable depends on the plan's tolerance for
 * attribute cardinality and event volume, and THAT COULD NOT BE CHECKED FROM
 * HERE: this was written without access to the Sentry organisation's billing
 * settings.
 *
 * So it takes the answer that is safe under either. Counts accumulate in
 * memory and one point per (organisation, outcome) is emitted per window, with
 * the window's sum as its value. Nothing is lost, the numbers are identical
 * when summed over time, and the volume is bounded by the number of active
 * organisations rather than by delivery traffic. If the plan later turns out to
 * be comfortable with per-package events, deleting the accumulator is an easy
 * change; discovering after a month that it was not is not.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * It never throws into the assignment path and never adds a query to it. Every
 * entry point returns synchronously and swallows its own failures: a metrics
 * backend having a bad day must not turn into a package that could not be
 * delivered. The one database read in here (how many territories has this
 * organisation actually drawn) happens on a flush, off the assignment path, and
 * only when an alert is already being considered.
 */
@Injectable()
export class CoverageMetricsService implements OnModuleDestroy {
    private readonly logger = new Logger(CoverageMetricsService.name);

    private windows = new Map<string, OrgWindow>();
    private windowStartedAtMs = Date.now();

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** One package placed, and how coverage explains where it went. */
    recordAssignment(organisationId: string, outcome: CoverageOutcome): void {
        const window = this.windowFor(organisationId);
        window.outcomes.set(outcome, (window.outcomes.get(outcome) ?? 0) + 1);
        this.tick();
    }

    /**
     * One new shift opened by automatic assignment, and which step opened it.
     *
     * The billing signal. Opening a shift is the only billed insert in the
     * assignment path, and service area matching adds a second place it can
     * happen (step 2, "open one for somebody who covers this address", which
     * runs BEFORE the step that would have put the package on an existing van).
     * That ordering was chosen on the judgement that an extra shift beats a
     * package leaving its driver's area, and this counter is how that judgement
     * gets checked against a real invoice rather than left as an assumption.
     * Step 2 versus step 4 is the part that matters: step 4 existed before this
     * feature, step 2 is the new spend.
     */
    recordShiftOpened(organisationId: string, step: 2 | 4): void {
        const window = this.windowFor(organisationId);
        window.shiftsOpened.set(step, (window.shiftsOpened.get(step) ?? 0) + 1);
        this.tick();
    }

    /**
     * Sends what has accumulated and starts a new window.
     *
     * Public so a test can drive it without waiting on a clock, and so shutdown
     * does not silently drop the last window.
     */
    async flush(): Promise<void> {
        // Swapped before the first await, so a package placed while this is
        // running lands in the new window rather than being counted twice or
        // lost.
        const windows = this.windows;
        this.windows = new Map();
        this.windowStartedAtMs = Date.now();

        for (const [organisationId, window] of windows) {
            const summary = summarise(organisationId, window);
            this.emit(summary);
            await this.alertOnFallbackRate(summary);
        }
    }

    async onModuleDestroy(): Promise<void> {
        await this.flush().catch(() => undefined);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private windowFor(organisationId: string): OrgWindow {
        const existing = this.windows.get(organisationId);
        if (existing) return existing;
        const fresh: OrgWindow = {
            outcomes: new Map(),
            shiftsOpened: new Map(),
        };
        this.windows.set(organisationId, fresh);
        return fresh;
    }

    /**
     * Flushes when the window is up, without a timer.
     *
     * A `setInterval` would be a second scheduled job in a module whose whole
     * point is that it has none (see DispatchModule), it would keep the process
     * alive in tests, and it would need a lifecycle hook to clear. Checking the
     * clock on the way past costs nothing and has one honest consequence: an
     * organisation that stops assigning packages does not emit its last partial
     * window until the next package or shutdown. That is the right trade for a
     * counter whose only consumers are questions about traffic that is flowing.
     */
    private tick(): void {
        if (Date.now() - this.windowStartedAtMs < FLUSH_INTERVAL_MS) return;
        void this.flush().catch((err: unknown) => {
            this.logger.warn(`Coverage metrics flush failed: ${String(err)}`);
        });
    }

    /** One counter point per non-empty bucket. Never throws. */
    private emit(summary: CoverageWindowSummary): void {
        try {
            for (const outcome of COVERAGE_OUTCOMES) {
                const value = summary.outcomes[outcome];
                if (value === 0) continue;
                Sentry.metrics.count('dispatch.assignment', value, {
                    attributes: {
                        organisation: summary.organisationId,
                        coverage_outcome: outcome,
                    },
                });
            }

            for (const [step, value] of [
                [2, summary.shiftsOpenedAtStep2],
                [4, summary.shiftsOpenedAtStep4],
            ] as const) {
                if (value === 0) continue;
                Sentry.metrics.count('dispatch.shift_opened', value, {
                    attributes: {
                        organisation: summary.organisationId,
                        step,
                    },
                });
            }
        } catch (err: unknown) {
            this.logger.warn(
                `Coverage metrics could not be emitted: ${String(err)}`,
            );
        }
    }

    /**
     * Warns when too much of an organisation's traffic is leaving its drivers'
     * areas — but only when that is actually a fault.
     *
     * AN ORGANISATION WITH NO TERRITORIES IS 100% FLOATER BY CONSTRUCTION AND
     * THAT IS CORRECT. Every driver covers everywhere, every package matches at
     * step 1, and nothing is wrong. Those never reach here, because a floater
     * match is not a fallback. The case this guard is for is subtler: an
     * organisation that has drawn nothing can still produce fallbacks (a
     * warehouse with no drivers at all covers nothing), and paging somebody
     * about the coverage configuration of an organisation that has never opened
     * the map is exactly the alert that teaches people to ignore alerts. So the
     * territory count is checked before anything is raised.
     *
     * That check is the only query in this file, and it is reached only when
     * the rate is already over the threshold and the sample is already big
     * enough, so it costs one indexed count per organisation per minute in the
     * worst case and nothing at all in the ordinary one.
     */
    private async alertOnFallbackRate(
        summary: CoverageWindowSummary,
    ): Promise<void> {
        if (summary.decisions < MIN_DECISIONS_BEFORE_ALERT) return;
        const rate = summary.fallbacks / summary.decisions;
        if (rate <= FALLBACK_RATE_ALERT_THRESHOLD) return;

        let liveAreas: number;
        try {
            liveAreas = await this.countLiveAreas(summary.organisationId);
        } catch (err: unknown) {
            // No answer means no alert. Guessing "they probably have areas"
            // would page on a database blip; guessing the other way is silent.
            // Silent is recoverable, since the next window asks again.
            this.logger.warn(
                `Could not check territory count for ${summary.organisationId}, ` +
                    `skipping the coverage fallback alert: ${String(err)}`,
            );
            return;
        }
        if (liveAreas === 0) return;

        const message =
            `Coverage fallback rate ${(rate * 100).toFixed(0)}% for ` +
            `organisation ${summary.organisationId}: ${summary.fallbacks} of ` +
            `${summary.decisions} package(s) went to a driver who does not ` +
            `cover the delivery point, across ${liveAreas} live territory ` +
            `(or territories). Either a territory is missing over those ` +
            `addresses, or the drivers staffed on it have no room.`;

        this.logger.warn(message);
        try {
            Sentry.captureMessage(message, {
                level: 'warning',
                tags: {
                    organisation: summary.organisationId,
                    feature: 'service_area_matching',
                },
                extra: {
                    ...summary.outcomes,
                    decisions: summary.decisions,
                    fallbacks: summary.fallbacks,
                    liveServiceAreas: liveAreas,
                    thresholdRate: FALLBACK_RATE_ALERT_THRESHOLD,
                    windowMs: FLUSH_INTERVAL_MS,
                },
            });
        } catch (err: unknown) {
            this.logger.warn(
                `Coverage fallback alert could not be sent: ${String(err)}`,
            );
        }
    }

    /** Live (not soft-deleted) territories the organisation has drawn. */
    private async countLiveAreas(organisationId: string): Promise<number> {
        const rows: { count: number | string }[] = await this.dataSource.query(
            `SELECT count(*)::int AS count
               FROM service_areas
              WHERE organisation_id = $1::uuid AND is_deleted = false`,
            [organisationId],
        );
        return Number(rows[0]?.count ?? 0);
    }
}

/**
 * Turns one window's tallies into the flat shape the emitter and the alert
 * both read. Pure, and exported so the bucketing rule (which outcomes count as
 * a decision, which count as a fallback) can be tested without Sentry.
 */
export function summarise(
    organisationId: string,
    window: OrgWindow,
): CoverageWindowSummary {
    const outcomes = Object.fromEntries(
        COVERAGE_OUTCOMES.map((outcome) => [
            outcome,
            window.outcomes.get(outcome) ?? 0,
        ]),
    ) as Record<CoverageOutcome, number>;

    // `disabled` is excluded from the denominator on purpose. With the kill
    // switch off no coverage question was asked, so counting those as decisions
    // would report a 0% fallback rate for an organisation the feature is not
    // running for and make the flag look like a success.
    const decisions = COVERAGE_OUTCOMES.filter(
        (outcome) => outcome !== 'disabled',
    ).reduce((total, outcome) => total + outcomes[outcome], 0);

    const fallbacks = FALLBACK_OUTCOMES.reduce(
        (total, outcome) => total + outcomes[outcome],
        0,
    );

    return {
        organisationId,
        outcomes,
        decisions,
        fallbacks,
        shiftsOpenedAtStep2: window.shiftsOpened.get(2) ?? 0,
        shiftsOpenedAtStep4: window.shiftsOpened.get(4) ?? 0,
    };
}
