/**
 * The one place that decides what an organisation's billing state means.
 *
 * Two callers read it and they must not disagree: `PermissionGuard` blocks an
 * expired org, and `BillingService` tells the dashboard what to render. If
 * those two drifted, a user could be shown "3 days left" while every request
 * came back 402 — so the interpretation lives here rather than in either of
 * them.
 *
 * Stripe is the source of truth: `subscriptionStatus` is a cached copy of a
 * Stripe subscription's `status`, synced by the customer.subscription.*
 * webhook (see BillingService.syncSubscriptionFromStripe), plus the
 * 'grandfathered' sentinel backfilled onto every company org that predates
 * Stripe billing (see the AddOrganisationSubscriptionStatus migration).
 * `trialEndsAt` is only meaningful while `subscriptionStatus === 'trialing'`.
 *
 * Pure and dependency-free by design, which is also what makes the boundary
 * cases testable without booting Nest.
 */

/** What an organisation's billing state resolves to at a given instant. */
export type TrialState = 'none' | 'active' | 'expired';

/** Milliseconds in a day, for the countdown below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stripe subscription statuses that mean access should be refused. An
 * allow-list, not a deny-list: an unrecognised or future Stripe status must
 * fail open rather than lock an org out because this list did not anticipate
 * it. `trial_settings.end_behavior.missing_payment_method: 'cancel'` (set at
 * subscription creation) is what drives a lapsed trial into 'canceled' here —
 * there is no payment-collection flow yet, so 'past_due'/'incomplete' are not
 * reachable in practice, but are deliberately left out of this set rather than
 * blocked, since a future retrying-payment customer should not be locked out
 * mid-retry.
 */
const BLOCKING_STATUSES = new Set([
    'canceled',
    'incomplete_expired',
    'unpaid',
]);

/**
 * Resolve a cached subscription status (+ trial deadline) to a state.
 *
 * - No status (NULL) — no Stripe subscription applies: a personal org, or a
 *   company org BillingService has not provisioned yet. Unrestricted.
 * - 'grandfathered' — a company org that predates Stripe billing. Unrestricted,
 *   permanently: it was never told it was on a metered trial.
 * - 'trialing' — a real trial is running. `trialEndsAt` is still checked even
 *   here, as a safety net for a webhook that lags behind the deadline it
 *   reports.
 * - 'active' — paying. Unrestricted; nothing left to show.
 * - a status in BLOCKING_STATUSES — refused.
 * - anything else (including a future/unrecognised Stripe status) — fails
 *   open, unrestricted.
 */
export function trialState(
    subscriptionStatus: string | null | undefined,
    trialEndsAt: Date | null | undefined,
    now: Date = new Date(),
): TrialState {
    if (subscriptionStatus && BLOCKING_STATUSES.has(subscriptionStatus)) {
        return 'expired';
    }
    if (subscriptionStatus === 'trialing') {
        if (trialEndsAt && trialEndsAt.getTime() <= now.getTime()) {
            return 'expired';
        }
        return 'active';
    }
    return 'none';
}

/**
 * Whether access should be refused. Only ever true for `expired` — kept as its
 * own function so call sites read as a decision rather than a string compare.
 */
export function isTrialExpired(
    subscriptionStatus: string | null | undefined,
    trialEndsAt: Date | null | undefined,
    now: Date = new Date(),
): boolean {
    return trialState(subscriptionStatus, trialEndsAt, now) === 'expired';
}

/**
 * Whether an organisation is currently entitled to the `vanity_url` Stripe
 * Entitlement Feature. Mirrors `get_booking_organisation()`/
 * `get_tracking_details()`'s DB-side match condition exactly, so a caller in
 * Node (BillingService's status endpoint) and a caller in Postgres (the
 * vanity host itself) never disagree about whether a given org's vanity
 * subdomain should work.
 *
 * 'grandfathered' is unconditionally entitled, same "unrestricted,
 * permanently" reasoning as trialState() above — a grandfathered company org
 * never gets a Stripe customer, so there is no cached flag to read for it.
 * Every other org depends on the cached flag alone.
 */
export function hasVanityUrlEntitlement(
    subscriptionStatus: string | null | undefined,
    cachedFlag: boolean,
): boolean {
    return subscriptionStatus === 'grandfathered' || cachedFlag;
}

/**
 * Whole days left, floored, for the sidebar countdown. Null when no deadline
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
