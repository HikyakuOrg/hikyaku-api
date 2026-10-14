/**
 * The static path's rates. A Basic-plan shop can't ask hikyaku-api at
 * checkout, so each catalog service becomes fixed rates the app writes into
 * the shop's delivery profiles:
 *
 *   per_km / per_mi              one rate per distance band
 *   per_kg / per_lb              one rate per weight band
 *   per_delivery / per_recipient one flat rate (recipients = 1)
 *
 * A band is priced at its UPPER edge, so the shopper never pays less than the
 * live quote would charge for the same cart. Pure: no I/O.
 */
import { minorToDecimalString } from 'src/common/money';
import { amountFor } from 'src/services/price-amount';
import type { CatalogProduct } from 'src/services/services.service';
import type { BandSettingDto } from '../dto/shipping-rate-settings.dto';
import { SERVICE_CODE_PREFIX } from '../carrier-rates/carrier-rates';

export const KM_PER_MI = 1.609344;
export const GRAMS_PER_KG = 1000;
export const GRAMS_PER_LB = 453.59237;

/** The most bands one service may produce; PUT refuses settings above it. */
export const MAX_BANDS_PER_SERVICE = 50;

export type StaticRateKind = 'flat' | 'distance' | 'weight';
export type StaticRateUnit = 'km' | 'mi' | 'kg' | 'lb';

export interface StaticRate {
    /** Stable across resyncs while the service and its bands are unchanged. */
    code: string;
    service_id: string;
    service_name: string;
    description: string | null;
    kind: StaticRateKind;
    /** Decimal in the shop currency, e.g. "12.50". */
    price: string;
    /** The service's unit, null for flat rates. */
    unit: StaticRateUnit | null;
    /** Band edges in `unit`, null for flat rates. */
    band_min: number | null;
    band_max: number | null;
    /** Distance band edges in km, for the Function's haversine. */
    min_km?: number;
    max_km?: number;
    /** Weight band edges in grams, for Shopify's weight conditions. */
    min_grams?: number;
    max_grams?: number;
}

/** How many bands a width and a maximum make. */
export function bandCount(band: BandSettingDto): number {
    return Math.ceil(round3(band.max / band.band_width));
}

/** Band edges [min, max] in the service unit, the last one capped at `max`. */
export function bandEdges(band: BandSettingDto): [number, number][] {
    const edges: [number, number][] = [];
    const count = Math.min(bandCount(band), MAX_BANDS_PER_SERVICE);
    for (let i = 0; i < count; i++) {
        const min = round3(i * band.band_width);
        const max = round3(Math.min((i + 1) * band.band_width, band.max));
        if (max > min) edges.push([min, max]);
    }
    return edges;
}

/**
 * The rates for the chosen services, in the merchant's order. A service with
 * no amount in `currency`, or a banded one without band settings, gives no
 * rates (PUT already refuses both when rates are on).
 */
export function buildStaticRates(
    services: readonly CatalogProduct[],
    bandSettings: Readonly<Record<string, BandSettingDto>>,
    currency: string,
): StaticRate[] {
    const code = currency.toUpperCase();
    const rates: StaticRate[] = [];
    for (const s of services) {
        const unitMinor = amountFor(s, code);
        if (unitMinor === null) continue;
        const base = {
            service_id: s.productId,
            service_name: s.name,
            description: s.description,
        };
        const price = (quantity: number): string =>
            minorToDecimalString(Math.round(unitMinor * quantity), code);

        switch (s.pricingUnit) {
            case 'per_km':
            case 'per_mi': {
                const band = bandSettings[s.productId];
                if (!band) break;
                const unit = s.pricingUnit === 'per_km' ? 'km' : 'mi';
                const toKm = unit === 'km' ? 1 : KM_PER_MI;
                for (const [min, max] of bandEdges(band)) {
                    rates.push({
                        ...base,
                        code: `${SERVICE_CODE_PREFIX}${s.productId}:d:${min}-${max}`,
                        kind: 'distance',
                        price: price(max),
                        unit,
                        band_min: min,
                        band_max: max,
                        min_km: round3(min * toKm),
                        max_km: round3(max * toKm),
                    });
                }
                break;
            }
            case 'per_kg':
            case 'per_lb': {
                const band = bandSettings[s.productId];
                if (!band) break;
                const unit = s.pricingUnit === 'per_kg' ? 'kg' : 'lb';
                const toGrams = unit === 'kg' ? GRAMS_PER_KG : GRAMS_PER_LB;
                for (const [min, max] of bandEdges(band)) {
                    const minGrams = Math.round(min * toGrams);
                    const maxGrams = Math.round(max * toGrams);
                    rates.push({
                        ...base,
                        code: `${SERVICE_CODE_PREFIX}${s.productId}:w:${minGrams}-${maxGrams}`,
                        kind: 'weight',
                        price: price(max),
                        unit,
                        band_min: min,
                        band_max: max,
                        min_grams: minGrams,
                        max_grams: maxGrams,
                    });
                }
                break;
            }
            default:
                // per_delivery, and per_recipient with one recipient.
                rates.push({
                    ...base,
                    code: `${SERVICE_CODE_PREFIX}${s.productId}`,
                    kind: 'flat',
                    price: price(1),
                    unit: null,
                    band_min: null,
                    band_max: null,
                });
        }
    }
    return rates;
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}
