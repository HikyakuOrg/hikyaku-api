import { isTrialExpired, trialDaysRemaining, trialState } from './trial';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const offset = (ms: number) => new Date(NOW.getTime() + ms);

describe('trialState', () => {
    // No Stripe subscription applies — a personal org, or a company org
    // BillingService has not provisioned yet. Must stay unrestricted.
    it('treats a null status as "none", regardless of any stray deadline', () => {
        expect(trialState(null, null, NOW)).toBe('none');
        expect(trialState(undefined, undefined, NOW)).toBe('none');
        expect(trialState(null, offset(-30 * DAY), NOW)).toBe('none');
    });

    // The regression that matters most: every company org that predated Stripe
    // billing was backfilled to this sentinel and must never be locked out by
    // it, or silently re-enrolled into a trial it was never told it was on.
    it('treats "grandfathered" as permanently unrestricted', () => {
        expect(trialState('grandfathered', null, NOW)).toBe('none');
        expect(trialState('grandfathered', offset(-30 * DAY), NOW)).toBe('none');
    });

    it('is active while trialing and the deadline is in the future', () => {
        expect(trialState('trialing', offset(7 * DAY), NOW)).toBe('active');
        expect(trialState('trialing', offset(1), NOW)).toBe('active');
    });

    it('is expired once trialing but the cached deadline has passed', () => {
        // Belt-and-suspenders: status can lag a Stripe webhook that has not
        // landed yet, so the deadline is still honoured even while trialing.
        expect(trialState('trialing', offset(-1), NOW)).toBe('expired');
        expect(trialState('trialing', offset(-30 * DAY), NOW)).toBe('expired');
    });

    // The comparison is strictly-greater, so the deadline instant itself is over.
    it('counts the exact deadline as expired while trialing', () => {
        expect(trialState('trialing', NOW, NOW)).toBe('expired');
    });

    it('treats a paying subscription as unrestricted', () => {
        expect(trialState('active', offset(-30 * DAY), NOW)).toBe('none');
    });

    it.each(['canceled', 'incomplete_expired', 'unpaid'])(
        'refuses access for a "%s" subscription',
        (status) => {
            expect(trialState(status, null, NOW)).toBe('expired');
        },
    );

    // Anything this module does not recognise — a future Stripe status, or a
    // typo — must fail open rather than lock an org out of a state this list
    // never anticipated.
    it('fails open for an unrecognised status', () => {
        expect(trialState('some_future_status', null, NOW)).toBe('none');
    });
});

describe('isTrialExpired', () => {
    it('refuses access only for a blocked state', () => {
        expect(isTrialExpired(null, null, NOW)).toBe(false);
        expect(isTrialExpired('trialing', offset(HOUR), NOW)).toBe(false);
        expect(isTrialExpired('trialing', offset(-HOUR), NOW)).toBe(true);
        expect(isTrialExpired('canceled', null, NOW)).toBe(true);
        expect(isTrialExpired('grandfathered', offset(-HOUR), NOW)).toBe(false);
    });
});

describe('trialDaysRemaining', () => {
    it('is null when no deadline applies', () => {
        expect(trialDaysRemaining(null, NOW)).toBeNull();
    });

    it('floors partial days', () => {
        expect(trialDaysRemaining(offset(7 * DAY), NOW)).toBe(7);
        // 6 days 23 hours still reads as 6 — the dashboard pairs this with the
        // exact timestamp so the rounding is never the only signal.
        expect(trialDaysRemaining(offset(7 * DAY - HOUR), NOW)).toBe(6);
        expect(trialDaysRemaining(offset(HOUR), NOW)).toBe(0);
    });

    it('clamps to 0 rather than going negative once expired', () => {
        expect(trialDaysRemaining(offset(-5 * DAY), NOW)).toBe(0);
    });
});
