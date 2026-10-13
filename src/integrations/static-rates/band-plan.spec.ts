import type { CatalogProduct } from 'src/services/services.service';
import { bandCount, bandEdges, buildStaticRates } from './band-plan';

function service(overrides: Partial<CatalogProduct>): CatalogProduct {
    return {
        productId: 'prod_km',
        name: 'Standard',
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

describe('bandEdges', () => {
    it('cuts [0, max] into width-sized bands, capping the last', () => {
        expect(bandEdges({ band_width: 5, max: 12 })).toEqual([
            [0, 5],
            [5, 10],
            [10, 12],
        ]);
        expect(bandCount({ band_width: 5, max: 12 })).toBe(3);
    });

    it('does not drift on fractional widths', () => {
        expect(bandEdges({ band_width: 0.1, max: 0.3 })).toEqual([
            [0, 0.1],
            [0.1, 0.2],
            [0.2, 0.3],
        ]);
    });
});

describe('buildStaticRates', () => {
    it('prices distance bands at their upper edge, with km edges for miles', () => {
        const rates = buildStaticRates(
            [
                service({}),
                service({
                    productId: 'prod_mi',
                    pricingUnit: 'per_mi',
                    amountMinor: 200,
                }),
            ],
            {
                prod_km: { band_width: 5, max: 10 },
                prod_mi: { band_width: 10, max: 10 },
            },
            'aud',
        );
        expect(rates).toEqual([
            {
                code: 'hikyaku:prod_km:d:0-5',
                service_id: 'prod_km',
                service_name: 'Standard',
                description: 'Same day',
                kind: 'distance',
                price: '7.50',
                unit: 'km',
                band_min: 0,
                band_max: 5,
                min_km: 0,
                max_km: 5,
            },
            expect.objectContaining({
                code: 'hikyaku:prod_km:d:5-10',
                price: '15.00',
            }),
            expect.objectContaining({
                code: 'hikyaku:prod_mi:d:0-10',
                unit: 'mi',
                price: '20.00',
                max_km: 16.093,
            }),
        ]);
    });

    it('turns weight bands into grams, rounding lb', () => {
        const rates = buildStaticRates(
            [
                service({
                    productId: 'prod_kg',
                    pricingUnit: 'per_kg',
                    amountMinor: 100,
                }),
                service({
                    productId: 'prod_lb',
                    pricingUnit: 'per_lb',
                    amountMinor: 100,
                }),
            ],
            {
                prod_kg: { band_width: 2.5, max: 5 },
                prod_lb: { band_width: 1, max: 1 },
            },
            'AUD',
        );
        expect(rates.map((r) => [r.code, r.price])).toEqual([
            ['hikyaku:prod_kg:w:0-2500', '2.50'],
            ['hikyaku:prod_kg:w:2500-5000', '5.00'],
            ['hikyaku:prod_lb:w:0-454', '1.00'],
        ]);
        expect(rates[1]).toEqual(
            expect.objectContaining({
                kind: 'weight',
                unit: 'kg',
                band_min: 2.5,
                band_max: 5,
                min_grams: 2500,
                max_grams: 5000,
            }),
        );
    });

    it('gives flat units one rate, recipients counted once', () => {
        const rates = buildStaticRates(
            [
                service({
                    productId: 'prod_flat',
                    pricingUnit: 'per_delivery',
                    amountMinor: 1000,
                }),
                service({
                    productId: 'prod_rec',
                    pricingUnit: 'per_recipient',
                    amountMinor: 700,
                }),
            ],
            {},
            'AUD',
        );
        expect(rates).toEqual([
            expect.objectContaining({
                code: 'hikyaku:prod_flat',
                kind: 'flat',
                price: '10.00',
                unit: null,
                band_min: null,
                band_max: null,
            }),
            expect.objectContaining({
                code: 'hikyaku:prod_rec',
                price: '7.00',
            }),
        ]);
        expect(rates[0]).not.toHaveProperty('min_km');
    });

    it('prices in the shop currency and skips what it cannot price', () => {
        const rates = buildStaticRates(
            [
                service({
                    productId: 'prod_flat',
                    pricingUnit: 'per_delivery',
                    amountMinor: 1000,
                    currencyOptions: { jpy: 900 },
                }),
                // No band settings.
                service({}),
                // No amount in JPY.
                service({
                    productId: 'prod_other',
                    pricingUnit: 'per_delivery',
                }),
            ],
            {},
            'jpy',
        );
        expect(rates).toEqual([
            expect.objectContaining({
                code: 'hikyaku:prod_flat',
                price: '900',
            }),
        ]);
    });
});
