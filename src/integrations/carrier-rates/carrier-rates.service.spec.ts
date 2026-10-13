import type { DataSource } from 'typeorm';
import * as coverage from 'src/dispatch/coverage';
import * as dispatchSettings from 'src/dispatch/dispatch-settings';
import type { OrganisationsService } from 'src/organisations/organisations.service';
import type {
    CatalogProduct,
    ServicesService,
} from 'src/services/services.service';
import type { ValhallaService } from 'src/valhalla/valhalla.service';
import type { LocationMappingsService } from '../location-mappings.service';
import type { OrderGeocoder } from '../order-geocoder';
import { UngeocodableAddressError } from '../order-geocoder';
import type { ShippingRateSettingsService } from '../shipping-rate-settings.service';
import {
    CARRIER_RATE_BUDGET_MS,
    CarrierRatesService,
} from './carrier-rates.service';
import type { CarrierRateRequest } from './carrier-rates';

jest.mock('src/dispatch/coverage', () => ({
    ...jest.requireActual<typeof coverage>('src/dispatch/coverage'),
    coveringDriversForPoint: jest.fn(),
    allDriversAsFloatersForPoint: jest.fn(),
}));
jest.mock('src/dispatch/dispatch-settings', () => ({
    ...jest.requireActual<typeof dispatchSettings>(
        'src/dispatch/dispatch-settings',
    ),
    resolveDispatchSettings: jest.fn(),
}));

const ORG = 'org-1';
const W1 = 'b6ef9918-3656-48f9-bf72-48dba1df4625';
const SHOP = 'store.myshopify.com';

const KM: CatalogProduct = {
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
    defaultPriceId: 'price_km',
};
const FLAT: CatalogProduct = {
    ...KM,
    productId: 'prod_flat',
    name: 'Flat',
    amountMinor: 1000,
    pricingUnit: 'per_delivery',
};

const ADDRESS = {
    address1: '1 Collins St',
    address2: null,
    city: 'Melbourne',
    province_code: 'VIC',
    zip: '3000',
    country_code: 'AU',
};

function request(overrides: Partial<CarrierRateRequest['rate']> = {}) {
    return {
        rate: {
            origin: {
                country: 'AU',
                postal_code: '3000',
                city: 'Melbourne',
                address1: '1 Collins St',
            },
            destination: {
                country: 'AU',
                postal_code: '3121',
                province: 'VIC',
                city: 'Richmond',
                address1: '10 Swan St',
            },
            items: [{ grams: 1000, quantity: 2 }],
            currency: 'AUD',
            ...overrides,
        },
    };
}

const covering = coverage.coveringDriversForPoint as jest.Mock;
const floaters = coverage.allDriversAsFloatersForPoint as jest.Mock;
const resolveSettings = dispatchSettings.resolveDispatchSettings as jest.Mock;

describe('CarrierRatesService', () => {
    let service: CarrierRatesService;
    let query: jest.Mock;
    let findByShop: jest.Mock;
    let originCandidates: jest.Mock;
    let geocodeAddress: jest.Mock;
    let routeDistanceKm: jest.Mock;
    let fetchActiveProductMap: jest.Mock;

    const coverageOf = (driverIds: string[]) => ({
        pointIndex: 0,
        explicitDriverIds: driverIds,
        floaterDriverIds: [],
        driverIds,
    });

    beforeEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
        query = jest.fn().mockResolvedValue([{ lon: 144.96, lat: -37.81 }]);
        findByShop = jest.fn().mockResolvedValue({
            organisation_id: ORG,
            enabled: true,
            shop_currency: 'AUD',
            service_ids: ['prod_km', 'prod_flat'],
        });
        originCandidates = jest.fn().mockResolvedValue([
            {
                mode: 'warehouse',
                warehouse_id: W1,
                address: ADDRESS,
                stale_at: null,
            },
        ]);
        geocodeAddress = jest
            .fn()
            .mockResolvedValue({ lon: 145.0, lat: -37.82 });
        routeDistanceKm = jest.fn().mockResolvedValue(4);
        fetchActiveProductMap = jest.fn().mockResolvedValue(
            new Map([
                [KM.productId, KM],
                [FLAT.productId, FLAT],
            ]),
        );
        resolveSettings.mockResolvedValue({ serviceAreaMatching: true });
        covering.mockResolvedValue(coverageOf(['d1']));
        floaters.mockResolvedValue(coverageOf(['d1']));

        service = new CarrierRatesService(
            { query } as unknown as DataSource,
            { findByShop } as unknown as ShippingRateSettingsService,
            { originCandidates } as unknown as LocationMappingsService,
            { geocodeAddress } as unknown as OrderGeocoder,
            { routeDistanceKm } as unknown as ValhallaService,
            {
                getStripeAccount: jest
                    .fn()
                    .mockResolvedValue({ stripeAccountId: 'acct_1' }),
            } as unknown as OrganisationsService,
            { fetchActiveProductMap } as unknown as ServicesService,
        );
    });

    it('prices every chosen service inside coverage', async () => {
        const res = await service.rates(SHOP, request());
        expect(res.rates).toEqual([
            expect.objectContaining({
                service_code: 'hikyaku:prod_km',
                total_price: '600',
                currency: 'AUD',
            }),
            expect.objectContaining({
                service_code: 'hikyaku:prod_flat',
                total_price: '1000',
            }),
        ]);
        expect(routeDistanceKm).toHaveBeenCalledWith([
            [144.96, -37.81],
            [145.0, -37.82],
        ]);
        expect(covering).toHaveBeenCalledWith(
            expect.anything(),
            { organisationId: ORG, warehouseId: W1 },
            { lon: 145.0, lat: -37.82 },
        );
        expect(geocodeAddress).toHaveBeenCalledWith(
            expect.objectContaining({
                line1: '10 Swan St',
                postcode: '3121',
                country_code: 'AU',
            }),
            expect.any(Number),
        );
    });

    it('returns nothing outside coverage', async () => {
        covering.mockResolvedValueOnce(coverageOf([]));
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
    });

    it('asks the floater query when service area matching is off', async () => {
        resolveSettings.mockResolvedValueOnce({ serviceAreaMatching: false });
        const res = await service.rates(SHOP, request());
        expect(floaters).toHaveBeenCalled();
        expect(covering).not.toHaveBeenCalled();
        expect(res.rates).toHaveLength(2);
    });

    it('returns nothing when rates are disabled or the shop is unknown', async () => {
        findByShop.mockResolvedValueOnce(null);
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
        findByShop.mockResolvedValueOnce({
            organisation_id: ORG,
            enabled: false,
            shop_currency: 'AUD',
            service_ids: ['prod_km'],
        });
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
        expect(geocodeAddress).not.toHaveBeenCalled();
    });

    it('returns nothing for a presentment currency', async () => {
        expect(await service.rates(SHOP, request({ currency: 'USD' }))).toEqual(
            { rates: [] },
        );
    });

    it('returns nothing from an unmapped origin', async () => {
        originCandidates.mockResolvedValueOnce([
            {
                mode: 'unmapped',
                warehouse_id: null,
                address: ADDRESS,
                stale_at: null,
            },
        ]);
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
    });

    it('returns nothing when the destination cannot be geocoded', async () => {
        geocodeAddress.mockRejectedValueOnce(
            new UngeocodableAddressError('nope'),
        );
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
    });

    it('returns nothing on an upstream failure', async () => {
        routeDistanceKm.mockRejectedValueOnce(new Error('valhalla down'));
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
        query.mockRejectedValueOnce(new Error('db down'));
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
    });

    it('skips Valhalla when no service is priced by distance', async () => {
        findByShop.mockResolvedValueOnce({
            organisation_id: ORG,
            enabled: true,
            shop_currency: 'AUD',
            service_ids: ['prod_flat'],
        });
        const res = await service.rates(SHOP, request());
        expect(routeDistanceKm).not.toHaveBeenCalled();
        expect(res.rates).toHaveLength(1);
    });

    it('caches the catalog between checkouts', async () => {
        await service.rates(SHOP, request());
        await service.rates(SHOP, request());
        expect(fetchActiveProductMap).toHaveBeenCalledTimes(1);
    });

    it('answers no rates once the budget runs out', async () => {
        jest.useFakeTimers();
        routeDistanceKm.mockReturnValueOnce(new Promise(() => undefined));
        const pending = service.rates(SHOP, request());
        await jest.advanceTimersByTimeAsync(CARRIER_RATE_BUDGET_MS + 1);
        expect(await pending).toEqual({ rates: [] });
    });

    it('reuses a geocoded destination', async () => {
        await service.rates(SHOP, request());
        await service.rates(SHOP, request());
        expect(geocodeAddress).toHaveBeenCalledTimes(1);
    });

    it('lets a slow lookup finish after the budget and serves the next callback from it', async () => {
        jest.useFakeTimers();
        let resolve!: (p: { lon: number; lat: number }) => void;
        geocodeAddress.mockReturnValueOnce(
            new Promise((r) => {
                resolve = r;
            }),
        );
        const first = service.rates(SHOP, request());
        await jest.advanceTimersByTimeAsync(CARRIER_RATE_BUDGET_MS + 1);
        expect(await first).toEqual({ rates: [] });

        resolve({ lon: 145.0, lat: -37.82 });
        jest.useRealTimers();
        const second = await service.rates(SHOP, request());
        expect(second.rates).toHaveLength(2);
        expect(geocodeAddress).toHaveBeenCalledTimes(1);
    });

    it('retries a transient geocoder failure on the next callback', async () => {
        geocodeAddress.mockRejectedValueOnce(new Error('photon down'));
        expect(await service.rates(SHOP, request())).toEqual({ rates: [] });
        expect((await service.rates(SHOP, request())).rates).toHaveLength(2);
        expect(geocodeAddress).toHaveBeenCalledTimes(2);
    });

    it('honours CARRIER_RATE_BUDGET_MS', async () => {
        process.env.CARRIER_RATE_BUDGET_MS = '50';
        try {
            jest.useFakeTimers();
            routeDistanceKm.mockReturnValueOnce(new Promise(() => undefined));
            const pending = service.rates(SHOP, request());
            await jest.advanceTimersByTimeAsync(51);
            expect(await pending).toEqual({ rates: [] });
        } finally {
            delete process.env.CARRIER_RATE_BUDGET_MS;
        }
    });
});
