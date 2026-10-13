import {
    BadRequestException,
    ConflictException,
    UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { OrganisationsService } from 'src/organisations/organisations.service';
import type {
    CatalogProduct,
    ServicesService,
} from 'src/services/services.service';
import type { PutShippingRateSettingsDto } from './dto/shipping-rate-settings.dto';
import { ShippingRateSettingsService } from './shipping-rate-settings.service';

const ORG = 'org-1';
const USER = 'user-1';

function catalogItem(overrides: Partial<CatalogProduct>): CatalogProduct {
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
        defaultPriceId: 'price_km',
        ...overrides,
    };
}

const PER_KM = catalogItem({});
const FLAT = catalogItem({
    productId: 'prod_flat',
    name: 'Flat',
    description: null,
    amountMinor: 1000,
    currencyOptions: { nzd: 1100 },
    created: 2,
    pricingUnit: 'per_delivery',
});
const ADDON = catalogItem({
    productId: 'prod_addon',
    kind: 'addon',
    parentProductId: 'prod_km',
});

function storedRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'set-1',
        organisation_id: ORG,
        platform: 'shopify',
        shop_domain: 'store.myshopify.com',
        shop_currency: 'AUD',
        enabled: true,
        service_ids: ['prod_km'],
        path: 'live',
        band_settings: {},
        ...overrides,
    };
}

describe('ShippingRateSettingsService', () => {
    let service: ShippingRateSettingsService;
    let query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
    let getStripeAccount: jest.Mock;
    let fetchActiveProductMap: jest.Mock;

    beforeEach(() => {
        query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();
        getStripeAccount = jest
            .fn()
            .mockResolvedValue({ stripeAccountId: 'acct_1' });
        fetchActiveProductMap = jest
            .fn()
            .mockResolvedValue(
                new Map(
                    [FLAT, ADDON, PER_KM].map((p) => [p.productId, p] as const),
                ),
            );
        service = new ShippingRateSettingsService(
            { query } as unknown as DataSource,
            {
                getStripeAccount,
                findById: jest.fn().mockResolvedValue({ slug: 'acme' }),
            } as unknown as OrganisationsService,
            { fetchActiveProductMap } as unknown as ServicesService,
        );
        delete process.env.APP_URL;
    });

    const put = (
        overrides: Partial<PutShippingRateSettingsDto> = {},
    ): PutShippingRateSettingsDto => ({
        platform: 'shopify',
        shop_domain: ' Store.MyShopify.com ',
        shop_currency: 'aud',
        enabled: true,
        service_ids: ['prod_km'],
        path: 'live',
        ...overrides,
    });

    describe('getView', () => {
        it('returns defaults and services priced in the requested currency', async () => {
            query.mockResolvedValueOnce([]).mockResolvedValueOnce([{}]);
            process.env.APP_URL = 'https://app.hikyaku.org/';

            const view = await service.getView(
                ORG,
                USER,
                'shopify',
                'Store.myshopify.com',
                'nzd',
            );

            expect(query.mock.calls[0][1]).toEqual([
                ORG,
                'shopify',
                'store.myshopify.com',
            ]);
            expect(view.settings).toEqual({
                enabled: false,
                service_ids: [],
                shop_currency: null,
                path: null,
                band_settings: {},
            });
            expect(view.stripe_connected).toBe(true);
            // Services only, oldest first.
            expect(view.services).toEqual([
                {
                    id: 'prod_km',
                    name: 'Per km',
                    description: 'Same day',
                    unit: 'per_km',
                    amount: null,
                    currency: 'NZD',
                },
                {
                    id: 'prod_flat',
                    name: 'Flat',
                    description: null,
                    unit: 'per_delivery',
                    amount: '11.00',
                    currency: 'NZD',
                },
            ]);
            expect(view.dashboard_service_url).toBe(
                'https://app.hikyaku.org/orgs/acme/dashboard/service-rates',
            );
            expect(view.can_edit).toBe(true);
            expect(query.mock.calls[1][1]).toEqual([ORG, USER]);
        });

        it('falls back to the stored shop currency, and says when the caller cannot edit', async () => {
            query
                .mockResolvedValueOnce([storedRow()])
                .mockResolvedValueOnce([]);
            const view = await service.getView(ORG, USER, 'shopify', 'x');
            expect(view.can_edit).toBe(false);
            expect(view.settings.enabled).toBe(true);
            expect(view.services[0]).toEqual(
                expect.objectContaining({ amount: '1.50', currency: 'AUD' }),
            );
            expect(view.dashboard_service_url).toBeNull();
        });

        it('reports no Stripe and no services without a connected account', async () => {
            query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
            getStripeAccount.mockResolvedValueOnce(null);
            const view = await service.getView(ORG, USER, 'shopify', 'x');
            expect(view.stripe_connected).toBe(false);
            expect(view.services).toEqual([]);
        });
    });

    describe('put', () => {
        it('upserts on (platform, shop_domain) only when the row is this organisation’s', async () => {
            query.mockResolvedValueOnce([storedRow()]);

            const result = await service.put(ORG, USER, put());

            const [sql, params] = query.mock.calls[0];
            expect(sql).toContain('ON CONFLICT (platform, shop_domain)');
            expect(sql).toContain(
                'WHERE s.organisation_id = EXCLUDED.organisation_id',
            );
            expect(params).toEqual([
                ORG,
                'shopify',
                'store.myshopify.com',
                'AUD',
                true,
                ['prod_km'],
                'live',
                '{}',
                USER,
            ]);
            expect(result.service_ids).toEqual(['prod_km']);
        });

        it('409s when another organisation holds the shop', async () => {
            query.mockResolvedValueOnce([]);
            await expect(service.put(ORG, USER, put())).rejects.toThrow(
                ConflictException,
            );
        });

        const codeOf = async (
            p: Promise<unknown>,
        ): Promise<{ code: string; service_ids?: string[] }> => {
            try {
                await p;
            } catch (err) {
                expect(err).toBeInstanceOf(UnprocessableEntityException);
                return (err as UnprocessableEntityException).getResponse() as {
                    code: string;
                };
            }
            throw new Error('expected a 422');
        };

        it('rejects ids outside the catalog, add-ons included, even when disabling', async () => {
            const body = await codeOf(
                service.put(
                    ORG,
                    USER,
                    put({
                        enabled: false,
                        service_ids: ['prod_addon', 'nope'],
                    }),
                ),
            );
            expect(body).toEqual(
                expect.objectContaining({
                    code: 'unknown_service',
                    service_ids: ['prod_addon', 'nope'],
                }),
            );
            expect(query).not.toHaveBeenCalled();
        });

        it('rejects enabling without Stripe', async () => {
            getStripeAccount.mockResolvedValueOnce(null);
            const body = await codeOf(
                service.put(ORG, USER, put({ service_ids: [] })),
            );
            expect(body.code).toBe('stripe_not_connected');
        });

        it('rejects enabling with an empty catalog or no chosen service', async () => {
            fetchActiveProductMap.mockResolvedValueOnce(new Map());
            expect(
                (await codeOf(service.put(ORG, USER, put({ service_ids: [] }))))
                    .code,
            ).toBe('no_services');
            expect(
                (await codeOf(service.put(ORG, USER, put({ service_ids: [] }))))
                    .code,
            ).toBe('no_services');
        });

        it('needs a shop currency to enable', async () => {
            await expect(
                service.put(ORG, USER, put({ shop_currency: null })),
            ).rejects.toThrow(BadRequestException);
        });

        it('names each chosen service without an amount in the shop currency', async () => {
            const body = await codeOf(
                service.put(
                    ORG,
                    USER,
                    put({
                        shop_currency: 'NZD',
                        service_ids: ['prod_km', 'prod_flat'],
                    }),
                ),
            );
            expect(body).toEqual(
                expect.objectContaining({
                    code: 'service_missing_currency',
                    service_ids: ['prod_km'],
                }),
            );
        });

        it('lets a merchant disable whatever the catalog state', async () => {
            getStripeAccount.mockResolvedValueOnce(null);
            query.mockResolvedValueOnce([storedRow({ enabled: false })]);
            await service.put(
                ORG,
                USER,
                put({ enabled: false, service_ids: [] }),
            );
            expect(query).toHaveBeenCalledTimes(1);
        });

        it('requires valid bands for banded services on the static path', async () => {
            const body = await codeOf(
                service.put(
                    ORG,
                    USER,
                    put({
                        path: 'static',
                        service_ids: ['prod_km', 'prod_flat'],
                        band_settings: {
                            prod_km: { band_width: 0, max: 30 },
                        },
                    }),
                ),
            );
            expect(body).toEqual(
                expect.objectContaining({
                    code: 'band_settings_invalid',
                    service_ids: ['prod_km'],
                }),
            );
        });

        it('stores bands only for chosen banded services', async () => {
            query.mockResolvedValueOnce([storedRow()]);
            await service.put(
                ORG,
                USER,
                put({
                    path: 'static',
                    service_ids: ['prod_km', 'prod_flat'],
                    band_settings: {
                        prod_km: { band_width: 5, max: 30 },
                        prod_flat: { band_width: 1, max: 1 },
                        prod_other: { band_width: 1, max: 1 },
                    },
                }),
            );
            expect(JSON.parse(query.mock.calls[0][1]![7] as string)).toEqual({
                prod_km: { band_width: 5, max: 30 },
            });
        });
    });

    it('remove deletes only this organisation’s row for the shop', async () => {
        query.mockResolvedValueOnce([]);
        await service.remove(ORG, 'shopify', 'Store.myshopify.com');
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('WHERE organisation_id = $1');
        expect(params).toEqual([ORG, 'shopify', 'store.myshopify.com']);
    });
});
