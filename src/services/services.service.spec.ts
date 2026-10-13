import { BadRequestException } from '@nestjs/common';
import { ServicesService } from './services.service';
import type { OrganisationsService } from 'src/organisations/organisations.service';
import type { StripeClient } from 'src/stripe/stripe.provider';

/** A Stripe product as `products.list` returns it with the price expanded. */
function product(overrides: Record<string, unknown> = {}) {
    return {
        id: 'prod_1',
        name: 'Same-day',
        description: 'Our own drivers',
        created: 1,
        metadata: { kind: 'service', pricing_unit: 'per_km' },
        default_price: {
            id: 'price_1',
            unit_amount: 150,
            currency: 'aud',
            active: true,
            currency_options: {
                aud: { unit_amount: 150 },
                nzd: { unit_amount: 170 },
            },
        },
        ...overrides,
    };
}

describe('ServicesService currency options', () => {
    let service: ServicesService;
    let stripe: {
        accounts: { retrieve: jest.Mock };
        products: { create: jest.Mock; update: jest.Mock; list: jest.Mock };
        prices: { create: jest.Mock; update: jest.Mock };
    };

    beforeEach(() => {
        stripe = {
            accounts: {
                retrieve: jest.fn().mockResolvedValue({
                    charges_enabled: true,
                    default_currency: 'aud',
                }),
            },
            products: {
                create: jest.fn().mockResolvedValue({ id: 'prod_new' }),
                update: jest.fn().mockResolvedValue({}),
                list: jest.fn().mockReturnValue([product()]),
            },
            prices: {
                create: jest.fn().mockResolvedValue({ id: 'price_2' }),
                update: jest.fn().mockResolvedValue({}),
            },
        };
        const orgs = {
            getStripeAccount: jest
                .fn()
                .mockResolvedValue({ stripeAccountId: 'acct_1' }),
        };
        service = new ServicesService(
            stripe as unknown as StripeClient,
            orgs as unknown as OrganisationsService,
        );
    });

    it('creates the default price with currency_options and a description', async () => {
        await service.createService('org-1', {
            name: 'Same-day',
            amountMajor: 1.5,
            pricingUnit: 'per_km',
            description: 'Our own drivers',
            currencyOptions: [{ currency: 'NZD', amountMajor: 1.7 }],
        });
        expect(stripe.products.create).toHaveBeenCalledWith(
            expect.objectContaining({
                description: 'Our own drivers',
                default_price_data: {
                    unit_amount: 150,
                    currency: 'aud',
                    currency_options: { nzd: { unit_amount: 170 } },
                },
            }),
            { stripeAccount: 'acct_1' },
        );
    });

    it('rejects the main currency in currencyOptions on create', async () => {
        await expect(
            service.createService('org-1', {
                name: 'x',
                amountMajor: 1,
                pricingUnit: 'per_delivery',
                currencyOptions: [{ currency: 'aud', amountMajor: 1 }],
            }),
        ).rejects.toThrow(BadRequestException);
        expect(stripe.products.create).not.toHaveBeenCalled();
    });

    it('expands currency_options when listing and exposes them in the catalog', async () => {
        const catalog = await service.getCatalog('org-1');
        expect(stripe.products.list).toHaveBeenCalledWith(
            expect.objectContaining({
                expand: [
                    'data.default_price',
                    'data.default_price.currency_options',
                ],
            }),
            { stripeAccount: 'acct_1' },
        );
        expect(catalog.services[0]).toEqual(
            expect.objectContaining({
                amount_minor: 150,
                currency: 'aud',
                description: 'Our own drivers',
                currency_options: [{ currency: 'nzd', amount_minor: 170 }],
            }),
        );
    });

    it('mints a new price carrying the old currency_options when only the amount changes', async () => {
        await service.updateService('org-1', 'prod_1', { amountMajor: 2 });
        expect(stripe.prices.create).toHaveBeenCalledWith(
            {
                product: 'prod_1',
                unit_amount: 200,
                currency: 'aud',
                currency_options: { nzd: { unit_amount: 170 } },
            },
            { stripeAccount: 'acct_1' },
        );
        expect(stripe.prices.update).toHaveBeenCalledWith(
            'price_1',
            { active: false },
            { stripeAccount: 'acct_1' },
        );
    });

    it('replaces currency_options and keeps the main amount when only the list changes', async () => {
        await service.updateService('org-1', 'prod_1', {
            currencyOptions: [{ currency: 'usd', amountMajor: 1 }],
        });
        expect(stripe.prices.create).toHaveBeenCalledWith(
            {
                product: 'prod_1',
                unit_amount: 150,
                currency: 'aud',
                currency_options: { usd: { unit_amount: 100 } },
            },
            { stripeAccount: 'acct_1' },
        );
    });

    it('removes every extra currency when sent an empty list', async () => {
        await service.updateService('org-1', 'prod_1', {
            currencyOptions: [],
        });
        expect(stripe.prices.create).toHaveBeenCalledWith(
            { product: 'prod_1', unit_amount: 150, currency: 'aud' },
            { stripeAccount: 'acct_1' },
        );
    });

    it('patches the description without minting a price', async () => {
        await service.updateService('org-1', 'prod_1', { description: '' });
        expect(stripe.products.update).toHaveBeenCalledWith(
            'prod_1',
            { description: '' },
            { stripeAccount: 'acct_1' },
        );
        expect(stripe.prices.create).not.toHaveBeenCalled();
    });
});
