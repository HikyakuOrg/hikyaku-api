import { createHmac } from 'crypto';
import type { CatalogProduct } from 'src/services/services.service';
import {
    addressKey,
    buildRates,
    cartGrams,
    priceableServices,
    verifyShopifyHmac,
    warehouseForOrigin,
    type OriginCandidate,
} from './carrier-rates';

const W1 = 'b6ef9918-3656-48f9-bf72-48dba1df4625';
const W2 = 'c6f7a95b-c9cd-4037-9581-e05caf060049';

function service(overrides: Partial<CatalogProduct>): CatalogProduct {
    return {
        productId: 'prod_km',
        name: 'Per km',
        description: 'Same day',
        amountMinor: 150,
        currency: 'aud',
        currencyOptions: {},
        created: 1,
        pricingUnit: 'per_km',
        kind: 'service',
        parentProductId: null,
        defaultPriceId: 'price_1',
        ...overrides,
    };
}

const MELBOURNE = {
    address1: '1 Collins St.',
    address2: null,
    city: 'Melbourne',
    province_code: 'VIC',
    zip: '3000',
    country_code: 'AU',
};

function candidate(overrides: Partial<OriginCandidate> = {}): OriginCandidate {
    return {
        mode: 'warehouse',
        warehouse_id: W1,
        address: MELBOURNE,
        stale_at: null,
        ...overrides,
    };
}

const ORIGIN = {
    country: 'au',
    postal_code: '3000 ',
    city: 'MELBOURNE',
    address1: '1  collins st',
};

describe('verifyShopifyHmac', () => {
    const body = Buffer.from('{"rate":{}}');
    const sign = (secret: string) =>
        createHmac('sha256', secret).update(body).digest('base64');

    it('accepts the base64 HMAC of the raw body', () => {
        expect(verifyShopifyHmac(body, sign('s3cret'), 's3cret')).toBe(true);
    });

    it('rejects a wrong secret, a missing header and garbage', () => {
        expect(verifyShopifyHmac(body, sign('other'), 's3cret')).toBe(false);
        expect(verifyShopifyHmac(body, undefined, 's3cret')).toBe(false);
        expect(verifyShopifyHmac(body, 'not-base64!', 's3cret')).toBe(false);
    });

    it('rejects a signature over different bytes', () => {
        const other = Buffer.from('{"rate":{} }');
        expect(verifyShopifyHmac(other, sign('s3cret'), 's3cret')).toBe(false);
    });
});

describe('addressKey', () => {
    it('ignores case, spacing and punctuation', () => {
        expect(
            addressKey({
                country: 'AU',
                zip: '3000',
                address1: '1 Collins St.',
                city: 'Melbourne',
            }),
        ).toBe(
            addressKey({
                country: 'au',
                zip: ' 30 00',
                address1: '1  collins st',
                city: 'MELBOURNE ',
            }),
        );
    });

    it('needs a country and a street line', () => {
        expect(
            addressKey({ country: null, zip: '1', address1: 'x', city: 'y' }),
        ).toBeNull();
        expect(
            addressKey({ country: 'AU', zip: '1', address1: ' ', city: 'y' }),
        ).toBeNull();
    });
});

describe('warehouseForOrigin', () => {
    it('finds the mapped warehouse by address', () => {
        expect(warehouseForOrigin(ORIGIN, [candidate()])).toBe(W1);
    });

    it('ignores stale locations and other addresses', () => {
        expect(
            warehouseForOrigin(ORIGIN, [
                candidate({ stale_at: '2026-10-01T00:00:00Z' }),
                candidate({
                    warehouse_id: W2,
                    address: { ...MELBOURNE, address1: '2 Collins St' },
                }),
            ]),
        ).toBeNull();
    });

    it('gives no warehouse for an unmapped or not-delivered match', () => {
        expect(
            warehouseForOrigin(ORIGIN, [
                candidate({ mode: 'unmapped', warehouse_id: null }),
            ]),
        ).toBeNull();
        expect(
            warehouseForOrigin(ORIGIN, [
                candidate(),
                candidate({ mode: 'not_delivered', warehouse_id: null }),
            ]),
        ).toBeNull();
    });

    it('accepts several matches on one warehouse and refuses a split', () => {
        expect(warehouseForOrigin(ORIGIN, [candidate(), candidate()])).toBe(W1);
        expect(
            warehouseForOrigin(ORIGIN, [
                candidate(),
                candidate({ warehouse_id: W2 }),
            ]),
        ).toBeNull();
    });

    it('gives none without an origin', () => {
        expect(warehouseForOrigin(undefined, [candidate()])).toBeNull();
    });
});

describe('cartGrams', () => {
    it('sums grams × quantity over shippable items', () => {
        expect(
            cartGrams([
                { grams: 500, quantity: 2 },
                { grams: 250, quantity: 1 },
                { grams: 9999, quantity: 1, requires_shipping: false },
                { quantity: 3 },
            ]),
        ).toBe(1250);
    });
});

describe('priceableServices', () => {
    const km = service({});
    const nzdOnly = service({
        productId: 'prod_nzd',
        currency: 'nzd',
        amountMinor: 900,
    });
    const addon = service({ productId: 'prod_addon', kind: 'addon' });
    const catalog = new Map([km, nzdOnly, addon].map((s) => [s.productId, s]));

    it('keeps chosen services in order that exist and have the currency', () => {
        expect(
            priceableServices(
                ['prod_gone', 'prod_nzd', 'prod_addon', 'prod_km'],
                catalog,
                'AUD',
            ).map((s) => s.productId),
        ).toEqual(['prod_km']);
    });
});

describe('buildRates', () => {
    it('prices each service like a booking quote with one recipient', () => {
        const rates = buildRates(
            [
                service({}),
                service({
                    productId: 'prod_mi',
                    pricingUnit: 'per_mi',
                    amountMinor: 200,
                }),
                service({
                    productId: 'prod_kg',
                    pricingUnit: 'per_kg',
                    amountMinor: 100,
                    description: null,
                }),
                service({
                    productId: 'prod_flat',
                    pricingUnit: 'per_delivery',
                    amountMinor: 1000,
                    currency: 'usd',
                    currencyOptions: { aud: 1500 },
                }),
                service({
                    productId: 'prod_recipient',
                    pricingUnit: 'per_recipient',
                    amountMinor: 700,
                }),
            ],
            { distanceKm: 12.5, weightKg: 2.5 },
            'aud',
        );
        expect(rates).toEqual([
            {
                service_name: 'Per km',
                description: 'Same day',
                service_code: 'hikyaku:prod_km',
                currency: 'AUD',
                total_price: '1875',
            },
            expect.objectContaining({
                service_code: 'hikyaku:prod_mi',
                total_price: String(Math.round(200 * 12.5 * 0.621371)),
            }),
            expect.objectContaining({
                service_code: 'hikyaku:prod_kg',
                description: '',
                total_price: '250',
            }),
            expect.objectContaining({
                service_code: 'hikyaku:prod_flat',
                total_price: '1500',
            }),
            expect.objectContaining({
                service_code: 'hikyaku:prod_recipient',
                total_price: '700',
            }),
        ]);
    });
});
