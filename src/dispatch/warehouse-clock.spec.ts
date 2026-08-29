import {
    endOfLocalDayMs,
    localHourMs,
    localShiftDate,
    utcOffsetSuffix,
} from './warehouse-clock';

describe('localShiftDate', () => {
    it('is the UTC date at UTC', () => {
        expect(localShiftDate(new Date('2026-09-01T13:00:00Z'), 'UTC')).toBe('2026-09-01');
    });

    it('rolls forward for a zone ahead of UTC', () => {
        // 22:00 UTC is already the 2nd in Melbourne (UTC+10 in September).
        expect(
            localShiftDate(new Date('2026-09-01T22:00:00Z'), 'Australia/Melbourne'),
        ).toBe('2026-09-02');
    });

    it('rolls back for a zone behind UTC', () => {
        expect(localShiftDate(new Date('2026-09-01T02:00:00Z'), 'America/New_York')).toBe(
            '2026-08-31',
        );
    });

    it('handles a half-hour offset', () => {
        expect(localShiftDate(new Date('2026-09-01T18:45:00Z'), 'Asia/Kolkata')).toBe(
            '2026-09-02',
        );
    });

    it('falls back to UTC for a zone Postgres knows and Node does not', () => {
        // A warehouse with a nonsense timezone must still be able to take
        // packages; a wrong-but-working service day beats a 500 on every create.
        expect(localShiftDate(new Date('2026-09-01T13:00:00Z'), 'Mars/Olympus')).toBe(
            '2026-09-01',
        );
    });

    it('falls back to UTC when the column is null', () => {
        expect(localShiftDate(new Date('2026-09-01T13:00:00Z'), null)).toBe('2026-09-01');
    });
});

describe('utcOffsetSuffix', () => {
    it('reports a bare GMT as +00:00', () => {
        expect(utcOffsetSuffix(new Date('2026-09-01T00:00:00Z'), 'UTC')).toBe('+00:00');
    });

    it('reports a positive offset', () => {
        expect(
            utcOffsetSuffix(new Date('2026-09-01T00:00:00Z'), 'Australia/Melbourne'),
        ).toBe('+10:00');
    });

    it('reports a negative offset', () => {
        expect(utcOffsetSuffix(new Date('2026-01-15T00:00:00Z'), 'America/New_York')).toBe(
            '-05:00',
        );
    });

    it('follows daylight saving rather than assuming a fixed offset', () => {
        const winter = utcOffsetSuffix(new Date('2026-07-01T00:00:00Z'), 'Australia/Melbourne');
        const summer = utcOffsetSuffix(new Date('2026-01-01T00:00:00Z'), 'Australia/Melbourne');
        expect(winter).toBe('+10:00');
        expect(summer).toBe('+11:00');
    });
});

describe('endOfLocalDayMs', () => {
    it('is the last millisecond of the local day', () => {
        const end = endOfLocalDayMs(new Date('2026-09-01T13:00:00Z'), 'UTC');
        expect(new Date(end).toISOString()).toBe('2026-09-01T23:59:59.999Z');
    });

    it('accounts for the zone offset', () => {
        // Local 23:59:59.999 on 2 September in Melbourne (+10) is 13:59:59.999Z.
        const end = endOfLocalDayMs(
            new Date('2026-09-01T22:00:00Z'),
            'Australia/Melbourne',
        );
        expect(new Date(end).toISOString()).toBe('2026-09-02T13:59:59.999Z');
    });

    it('is always after the instant it was asked about', () => {
        const at = new Date('2026-09-01T22:00:00Z');
        expect(endOfLocalDayMs(at, 'Australia/Melbourne')).toBeGreaterThan(at.getTime());
    });
});

describe('localHourMs', () => {
    it('resolves a local hour on the local day', () => {
        const at = localHourMs(new Date('2026-09-01T13:00:00Z'), 'UTC', 8);
        expect(new Date(at).toISOString()).toBe('2026-09-01T08:00:00.000Z');
    });

    it('offsets the hour by the zone', () => {
        // 08:00 local on 2 September in Melbourne (+10) is 22:00Z on the 1st.
        const at = localHourMs(
            new Date('2026-09-01T22:00:00Z'),
            'Australia/Melbourne',
            8,
        );
        expect(new Date(at).toISOString()).toBe('2026-09-01T22:00:00.000Z');
    });

    it('pads a single-digit hour', () => {
        const at = localHourMs(new Date('2026-09-01T13:00:00Z'), 'UTC', 6);
        expect(new Date(at).toISOString()).toBe('2026-09-01T06:00:00.000Z');
    });
});
