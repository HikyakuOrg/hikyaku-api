import { isTrialExpired, trialDaysRemaining, trialState } from './trial';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const offset = (ms: number) => new Date(NOW.getTime() + ms);

describe('trialState', () => {
    // The whole migration rests on this: a null deadline marks an org the trial
    // never applied to, so reading it as expired would lock out every personal
    // org and every org created before the column existed.
    it('treats a missing deadline as "none", not "expired"', () => {
        expect(trialState(null, NOW)).toBe('none');
        expect(trialState(undefined, NOW)).toBe('none');
    });

    it('is active while the deadline is in the future', () => {
        expect(trialState(offset(7 * DAY), NOW)).toBe('active');
        expect(trialState(offset(1), NOW)).toBe('active');
    });

    it('is expired once the deadline has passed', () => {
        expect(trialState(offset(-1), NOW)).toBe('expired');
        expect(trialState(offset(-30 * DAY), NOW)).toBe('expired');
    });

    // The comparison is strictly-greater, so the deadline instant itself is over.
    it('counts the exact deadline as expired', () => {
        expect(trialState(NOW, NOW)).toBe('expired');
    });
});

describe('isTrialExpired', () => {
    it('refuses access only for an elapsed deadline', () => {
        expect(isTrialExpired(null, NOW)).toBe(false);
        expect(isTrialExpired(offset(HOUR), NOW)).toBe(false);
        expect(isTrialExpired(offset(-HOUR), NOW)).toBe(true);
    });
});

describe('trialDaysRemaining', () => {
    it('is null when no trial applies', () => {
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
