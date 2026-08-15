import { SetMetadata } from '@nestjs/common';

export const ALLOW_EXPIRED_TRIAL_KEY = 'allow_expired_trial';

/**
 * Exempts a handler from PermissionGuard's expired-trial check, which otherwise
 * answers 402 for every tenant-scoped route once an organisation's trial is over.
 *
 * Two kinds of route need this, and both are the same idea — a locked-out org
 * must still be able to see and undo its own lockout:
 *
 *   1. Routes that *report* trial state. GET /billing/trial is what the dashboard
 *      reads to decide whether to show the trial-ended dialog; if the guard blocked
 *      it, the user would get a bare error instead of an explanation.
 *   2. Routes that *resolve* the lockout — checkout, subscription, payment-method
 *      endpoints, once billing lands. Gating those behind an active trial would
 *      make expiry unrecoverable.
 *
 * Nothing else should carry it. It is not a general escape hatch: applying it to
 * a product route silently un-gates that feature for expired orgs.
 */
export const AllowExpiredTrial = () =>
    SetMetadata(ALLOW_EXPIRED_TRIAL_KEY, true);
