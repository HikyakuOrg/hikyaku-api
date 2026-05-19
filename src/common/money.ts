/**
 * Money / currency handling.
 *
 * Stripe is our only payment processor, so we model amounts exactly the way
 * Stripe expects them — NOT via ISO 4217. The two diverge: ISO 4217 lists ISK
 * and UGX as zero-decimal, but Stripe expects those charged as two-decimal
 * (amount * 100). Modelling on Stripe's own rules keeps the boundary correct.
 *
 * Reference: https://docs.stripe.com/currencies
 */

/**
 * Currencies Stripe charges with NO multiplication — the integer amount is the
 * major unit itself (e.g. 500 == ¥500). Source: Stripe "zero-decimal currencies".
 */
const STRIPE_ZERO_DECIMAL = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
    'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * Currencies Stripe charges in thousandths of the major unit. The card networks
 * only support two decimals, so the minor amount MUST be rounded to a multiple
 * of 10. Source: Stripe "three-decimal currencies".
 */
const STRIPE_THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

export type CurrencyExponent = 0 | 2 | 3;

/**
 * How many decimal places Stripe uses for `amount` / `unit_amount` in this
 * currency. Everything not explicitly zero- or three-decimal is two-decimal
 * (this intentionally includes ISK/HUF/TWD/UGX, which Stripe charges * 100).
 */
export function currencyExponent(currency: string): CurrencyExponent {
    const code = currency.trim().toUpperCase();
    if (STRIPE_ZERO_DECIMAL.has(code)) return 0;
    if (STRIPE_THREE_DECIMAL.has(code)) return 3;
    return 2;
}

/**
 * Convert a major-unit amount (e.g. dollars: 12.34, yen: 500) into the integer
 * Stripe expects in `unit_amount` for the given currency.
 *
 *   AUD 5.00  -> 500
 *   JPY 500   -> 500      (not 50000)
 *   KWD 5.001 -> 5000     (rounded to a multiple of 10)
 *
 * The result is what gets persisted as `payments.amount_minor` and sent to
 * Stripe, so there is a single representation everywhere.
 */
export function toStripeMinorUnits(amountMajor: number, currency: string): number {
    if (!Number.isFinite(amountMajor) || amountMajor < 0) {
        throw new Error(`Invalid monetary amount: ${amountMajor}`);
    }

    const exponent = currencyExponent(currency);
    const factor = exponent === 0 ? 1 : exponent === 3 ? 1000 : 100;

    // Scale, then round to the nearest integer minor unit. Rounding here (rather
    // than truncating) avoids binary-float artefacts like 19.99 * 100 = 1998.99…
    let minor = Math.round(amountMajor * factor);

    if (exponent === 3) {
        // Card networks accept only two decimals; the thousandths digit must be 0.
        minor = Math.round(minor / 10) * 10;
    }

    return minor;
}

/**
 * Inverse of {@link toStripeMinorUnits}: integer minor units back to a
 * major-unit number for display / formatting.
 *
 *   (500, 'AUD') -> 5
 *   (500, 'JPY') -> 500
 */
export function fromStripeMinorUnits(amountMinor: number, currency: string): number {
    if (!Number.isInteger(amountMinor)) {
        throw new Error(`Minor-unit amount must be an integer: ${amountMinor}`);
    }
    const exponent = currencyExponent(currency);
    const factor = exponent === 0 ? 1 : exponent === 3 ? 1000 : 100;
    return amountMinor / factor;
}
