/**
 * `pricing_unit` is our concept: it says how a priced item's Stripe Checkout
 * `quantity` is derived at booking time. The Stripe unit_amount (the per-unit
 * rate) is multiplied by this quantity to get the line total.
 *
 *   per_delivery  -> 1            (flat)
 *   per_recipient -> recipients   (integer)
 *   per_km        -> route distance in km
 *   per_mi        -> route distance in mi
 *   per_kg        -> parcel weight in kg
 *   per_lb        -> parcel weight in lb
 */
export const PRICING_UNITS = [
    'per_delivery',
    'per_km',
    'per_mi',
    'per_kg',
    'per_lb',
    'per_recipient',
] as const;

export type PricingUnit = (typeof PRICING_UNITS)[number];

// Distances are measured once in km via ORS; miles/weight-lb are derived so we
// never make a second ORS call or trust a client-supplied unit.
const MI_PER_KM = 0.621371;
const LB_PER_KG = 2.2046226218;

/**
 * Integer-quantity units bill via Stripe's native `{ price, quantity }` line
 * (Stripe multiplies). Fractional units (distance/weight) are emitted instead as
 * server-computed `price_data` with the fractional quantity folded into
 * `unit_amount` and `quantity: 1`, so the charged cents are exact (R4).
 */
export function isIntegerUnit(unit: string): boolean {
    return unit === 'per_delivery' || unit === 'per_recipient';
}

export interface QuantityContext {
    /** Route distance in km (ORS), 0 when no per-distance item is present. */
    distanceKm: number;
    /** Parcel weight in kg (canonical). */
    weightKg: number;
    /** Number of recipients on the booking. */
    recipientCount: number;
}

/** Quantity Stripe should bill for an item of `unit`, given the booking context. */
export function quantityForUnit(unit: string, ctx: QuantityContext): number {
    switch (unit) {
        case 'per_delivery':
            return 1;
        case 'per_recipient':
            return ctx.recipientCount;
        case 'per_km':
            return ctx.distanceKm;
        case 'per_mi':
            return ctx.distanceKm * MI_PER_KM;
        case 'per_kg':
            return ctx.weightKg;
        case 'per_lb':
            return ctx.weightKg * LB_PER_KG;
        default:
            return 1;
    }
}

/** Human-facing unit suffix, e.g. "km". Empty for per_delivery. */
export function unitSuffix(unit: string): string {
    switch (unit) {
        case 'per_km':
            return 'km';
        case 'per_mi':
            return 'mi';
        case 'per_kg':
            return 'kg';
        case 'per_lb':
            return 'lb';
        case 'per_recipient':
            return 'recipient';
        default:
            return '';
    }
}
