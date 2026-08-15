/**
 * The one place that decides what a `trial_ends_at` value means.
 *
 * Two callers read the column and they must not disagree: `PermissionGuard`
 * blocks expired orgs, and `BillingService` tells the dashboard what to render.
 * If those two drifted, a user could be shown "3 days left" while every request
 * came back 402 — so the comparison lives here rather than in either of them.
 *
 * Pure and dependency-free by design, which is also what makes the boundary
 * cases testable without booting Nest.
 */

/** What a trial deadline resolves to at a given instant. */
export type TrialState = 'none' | 'active' | 'expired';

/** Milliseconds in a day, for the countdown below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a deadline to a state.
 *
 * NULL is `none`, not `expired`: it marks an org the trial never applied to
 * (personal orgs, and orgs created before the column existed), and treating it
 * as expired would lock out every one of them.
 */
export function trialState(
    trialEndsAt: Date | null | undefined,
    now: Date = new Date(),
): TrialState {
    if (!trialEndsAt) return 'none';
    return trialEndsAt.getTime() > now.getTime() ? 'active' : 'expired';
}

/**
 * Whether access should be refused. Only ever true for `expired` — kept as its
 * own function so call sites read as a decision rather than a string compare.
 */
export function isTrialExpired(
    trialEndsAt: Date | null | undefined,
    now: Date = new Date(),
): boolean {
    return trialState(trialEndsAt, now) === 'expired';
}

/**
 * Whole days left, floored, for the sidebar countdown. Null when no trial
 * applies; 0 once the deadline passes rather than a negative number, so the UI
 * never has to special-case the sign.
 *
 * Flooring means "1" covers everything from 24h to 48h remaining, and the last
 * day of a trial reads "0 days left" — deliberate, since the dashboard shows the
 * exact end timestamp alongside it.
 */
export function trialDaysRemaining(
    trialEndsAt: Date | null | undefined,
    now: Date = new Date(),
): number | null {
    if (!trialEndsAt) return null;
    const ms = trialEndsAt.getTime() - now.getTime();
    return ms <= 0 ? 0 : Math.floor(ms / DAY_MS);
}
