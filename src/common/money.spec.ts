import { currencyExponent, fromStripeMinorUnits, toStripeMinorUnits } from './money';

describe('currencyExponent', () => {
    it('treats common currencies as two-decimal', () => {
        expect(currencyExponent('AUD')).toBe(2);
        expect(currencyExponent('usd')).toBe(2);
        expect(currencyExponent('EUR')).toBe(2);
    });

    it('treats Stripe zero-decimal currencies as zero-decimal', () => {
        expect(currencyExponent('JPY')).toBe(0);
        expect(currencyExponent('KRW')).toBe(0);
        expect(currencyExponent('VND')).toBe(0);
    });

    it('treats Stripe three-decimal currencies as three-decimal', () => {
        expect(currencyExponent('KWD')).toBe(3);
        expect(currencyExponent('BHD')).toBe(3);
    });

    it('treats ISK/UGX as two-decimal (Stripe, not ISO 4217)', () => {
        expect(currencyExponent('ISK')).toBe(2);
        expect(currencyExponent('UGX')).toBe(2);
    });
});

describe('toStripeMinorUnits', () => {
    it('multiplies two-decimal currencies by 100', () => {
        expect(toStripeMinorUnits(5, 'AUD')).toBe(500);
        expect(toStripeMinorUnits(12.34, 'USD')).toBe(1234);
    });

    it('does not scale zero-decimal currencies', () => {
        expect(toStripeMinorUnits(500, 'JPY')).toBe(500);
        expect(toStripeMinorUnits(500, 'JPY')).not.toBe(50000);
    });

    it('scales three-decimal currencies by 1000 and rounds to a multiple of 10', () => {
        expect(toStripeMinorUnits(5, 'KWD')).toBe(5000);
        expect(toStripeMinorUnits(5.001, 'KWD')).toBe(5000);
        expect(toStripeMinorUnits(5.009, 'KWD')).toBe(5010);
    });

    it('avoids binary-float rounding artefacts', () => {
        expect(toStripeMinorUnits(19.99, 'AUD')).toBe(1999);
        expect(toStripeMinorUnits(0.1 + 0.2, 'USD')).toBe(30);
    });

    it('rejects invalid amounts', () => {
        expect(() => toStripeMinorUnits(-1, 'AUD')).toThrow();
        expect(() => toStripeMinorUnits(NaN, 'AUD')).toThrow();
    });
});

describe('fromStripeMinorUnits', () => {
    it('round-trips two- and zero-decimal currencies', () => {
        expect(fromStripeMinorUnits(500, 'AUD')).toBe(5);
        expect(fromStripeMinorUnits(500, 'JPY')).toBe(500);
        expect(fromStripeMinorUnits(5000, 'KWD')).toBe(5);
    });

    it('rejects non-integer minor units', () => {
        expect(() => fromStripeMinorUnits(1.5, 'AUD')).toThrow();
    });
});
