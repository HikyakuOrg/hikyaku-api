/**
 * The pure half of the Shopify carrier rate callback: verifying the request,
 * finding its origin location, and turning a catalog into rates. Everything
 * here is decidable without I/O; carrier-rates.service.ts does the lookups.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { quantityForUnit } from 'src/services/pricing';
import { amountFor } from 'src/services/price-amount';
import type { CatalogProduct } from 'src/services/services.service';
import type { StoredLocationAddress } from '../location-mappings.service';

/** One address in a carrier rate request. Shopify fills only some fields. */
export interface CarrierRateAddress {
    country?: string | null;
    postal_code?: string | null;
    province?: string | null;
    city?: string | null;
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    address3?: string | null;
    company_name?: string | null;
}

export interface CarrierRateItem {
    name?: string;
    sku?: string;
    quantity?: number;
    /** Weight of one unit, in grams. */
    grams?: number;
    requires_shipping?: boolean;
}

/** Body Shopify POSTs to a carrier service callback. */
export interface CarrierRateRequest {
    rate?: {
        origin?: CarrierRateAddress;
        destination?: CarrierRateAddress;
        items?: CarrierRateItem[];
        currency?: string;
        locale?: string;
    };
}

/** One rate in the callback's answer. */
export interface CarrierRate {
    service_name: string;
    description: string;
    service_code: string;
    currency: string;
    /** Minor units, as a string, as Shopify expects. */
    total_price: string;
}

export interface CarrierRateResponse {
    rates: CarrierRate[];
}

/** Prefix on `service_code`, so the app can spot our shipping line. */
export const SERVICE_CODE_PREFIX = 'hikyaku:';

/**
 * Whether `hmacHeader` is the base64 HMAC-SHA256 of the raw body under the
 * app's client secret. Constant-time.
 */
export function verifyShopifyHmac(
    rawBody: Buffer,
    hmacHeader: string | undefined,
    secret: string,
): boolean {
    if (!hmacHeader) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let given: Buffer;
    try {
        given = Buffer.from(hmacHeader, 'base64');
    } catch {
        return false;
    }
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A storefront location as the origin match reads it. */
export interface OriginCandidate {
    mode: 'warehouse' | 'not_delivered' | 'unmapped';
    warehouse_id: string | null;
    address: StoredLocationAddress | null;
    stale_at: string | Date | null;
}

/**
 * The comparable form of an address: country, postcode, street line and
 * city, each lower case with spaces and punctuation collapsed. Null without a
 * country or a street line, since those alone can't pin a location down.
 */
export function addressKey(parts: {
    country: string | null | undefined;
    zip: string | null | undefined;
    address1: string | null | undefined;
    city: string | null | undefined;
}): string | null {
    const norm = (v: string | null | undefined): string =>
        (v ?? '')
            .toLowerCase()
            .replace(/[.,'#]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    const country = norm(parts.country);
    const address1 = norm(parts.address1);
    if (!country || !address1) return null;
    return [
        country,
        norm(parts.zip).replace(/\s/g, ''),
        address1,
        norm(parts.city),
    ].join('|');
}

/**
 * The warehouse that ships for the request's origin, or null. The request
 * names its origin only by address, so the shop's live locations are
 * matched on it. Several matches must agree on one warehouse; any match that
 * is unmapped or not delivered by Hikyaku means no rate, since we can't
 * tell which location Shopify meant.
 */
export function warehouseForOrigin(
    origin: CarrierRateAddress | undefined,
    candidates: readonly OriginCandidate[],
): string | null {
    if (!origin) return null;
    const key = addressKey({
        country: origin.country,
        zip: origin.postal_code,
        address1: origin.address1,
        city: origin.city,
    });
    if (!key) return null;

    const matched = candidates.filter(
        (c) =>
            c.stale_at === null &&
            c.address !== null &&
            addressKey({
                country: c.address.country_code,
                zip: c.address.zip,
                address1: c.address.address1,
                city: c.address.city,
            }) === key,
    );
    if (matched.length === 0) return null;
    if (matched.some((c) => c.mode !== 'warehouse' || !c.warehouse_id)) {
        return null;
    }
    const warehouses = new Set(matched.map((c) => c.warehouse_id));
    return warehouses.size === 1 ? matched[0].warehouse_id : null;
}

/** Cart weight in grams: Σ grams × quantity over items that ship. */
export function cartGrams(
    items: readonly CarrierRateItem[] | undefined,
): number {
    let total = 0;
    for (const item of items ?? []) {
        if (item.requires_shipping === false) continue;
        const grams = Number(item.grams);
        const quantity = Number(item.quantity ?? 1);
        if (Number.isFinite(grams) && Number.isFinite(quantity)) {
            total += Math.max(0, grams) * Math.max(0, quantity);
        }
    }
    return total;
}

export function needsDistance(services: readonly CatalogProduct[]): boolean {
    return services.some(
        (s) => s.pricingUnit === 'per_km' || s.pricingUnit === 'per_mi',
    );
}

/**
 * The chosen services that still exist as catalog services, in the order the
 * merchant chose them, and that have an amount in `currency`.
 */
export function priceableServices(
    serviceIds: readonly string[],
    catalog: ReadonlyMap<string, CatalogProduct>,
    currency: string,
): CatalogProduct[] {
    const out: CatalogProduct[] = [];
    for (const id of serviceIds) {
        const s = catalog.get(id);
        if (!s || s.kind !== 'service') continue;
        if (amountFor(s, currency) === null) continue;
        out.push(s);
    }
    return out;
}

/**
 * One rate per service, priced the way a booking quote prices its base
 * service: unit amount × quantity, with recipients = 1 and no add-ons.
 * `currency` is upper case, as Shopify sends it.
 */
export function buildRates(
    services: readonly CarrierRateService[],
    ctx: { distanceKm: number; weightKg: number },
    currency: string,
): CarrierRate[] {
    return services.map((s) => {
        const unitMinor = amountFor(s, currency) ?? 0;
        const quantity = quantityForUnit(s.pricingUnit, {
            distanceKm: ctx.distanceKm,
            weightKg: ctx.weightKg,
            recipientCount: 1,
        });
        return {
            service_name: s.name,
            description: s.description ?? '',
            service_code: `${SERVICE_CODE_PREFIX}${s.productId}`,
            currency: currency.toUpperCase(),
            total_price: String(Math.round(unitMinor * quantity)),
        };
    });
}

type CarrierRateService = Pick<
    CatalogProduct,
    | 'productId'
    | 'name'
    | 'description'
    | 'pricingUnit'
    | 'currency'
    | 'amountMinor'
    | 'currencyOptions'
>;
