import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { CustomersService } from './customers.service';

describe('CustomersService', () => {
    let service: CustomersService;
    let stripe: { customers: { create: jest.Mock; update: jest.Mock } };
    let dataSource: { query: jest.Mock };
    let orgs: { getStripeAccount: jest.Mock };

    const address = {
        lon: 144.9,
        lat: -37.8,
        street: '123 Example St',
        suburb: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
        country: 'AU',
    };

    beforeEach(async () => {
        stripe = { customers: { create: jest.fn(), update: jest.fn() } };
        dataSource = { query: jest.fn() };
        orgs = { getStripeAccount: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CustomersService,
                { provide: STRIPE_CLIENT, useValue: stripe },
                { provide: getDataSourceToken(), useValue: dataSource },
                { provide: OrganisationsService, useValue: orgs },
            ],
        }).compile();

        service = module.get<CustomersService>(CustomersService);
    });

    describe('upsertFromBooking', () => {
        it('targets the phone ON CONFLICT tier and still syncs to Stripe (unchanged behavior)', async () => {
            dataSource.query
                .mockResolvedValueOnce([{ id: 'cust-1' }]) // upsertCustomerRow INSERT
                .mockResolvedValueOnce([]); // UPDATE stripe_customer_id
            stripe.customers.create.mockResolvedValue({ id: 'stripe-cust-1' });

            const result = await service.upsertFromBooking(
                {
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    email: 'jane@example.com',
                    address,
                },
                'acct_1',
                'org-1',
                'idem-key-1',
            );

            expect(result).toBe('cust-1');

            const [insertSql, insertParams] = dataSource.query.mock.calls[0];
            expect(insertSql).toContain(
                'ON CONFLICT (organisation_id, lower(customer_phone)) WHERE customer_phone IS NOT NULL',
            );
            expect(insertParams).toEqual(
                expect.arrayContaining([
                    'org-1',
                    'Jane Doe',
                    '+61400000000',
                    'jane@example.com',
                ]),
            );

            expect(stripe.customers.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    metadata: { db_customer_id: 'cust-1' },
                }),
                { stripeAccount: 'acct_1', idempotencyKey: 'idem-key-1' },
            );

            const [updateSql, updateParams] = dataSource.query.mock.calls[1];
            expect(updateSql).toContain('SET stripe_customer_id = $1');
            expect(updateParams).toEqual(['stripe-cust-1', 'cust-1']);
        });

        it('swallows a Stripe failure and still returns the DB customer id', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-2' }]);
            stripe.customers.create.mockRejectedValue(new Error('stripe down'));

            const result = await service.upsertFromBooking(
                { name: 'Bob Smith', phone: '+61400000001', address },
                'acct_1',
                'org-1',
                'idem-key-2',
            );

            expect(result).toBe('cust-2');
            expect(dataSource.query).toHaveBeenCalledTimes(1); // no follow-up UPDATE attempted
        });

        it('never issues a shopify_customer_id update', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-3' }]);

            await service.upsertFromBooking(
                { name: 'Amy Lee', phone: '+61400000002', address },
                null,
                'org-1',
                'idem-key-3',
            );

            for (const [sql] of dataSource.query.mock.calls) {
                expect(sql).not.toContain('shopify_customer_id');
            }
        });
    });

    describe('upsertFromShopifyOrder', () => {
        it('targets the phone tier when phone is present, and never touches Stripe', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-4' }]);

            const result = await service.upsertFromShopifyOrder(
                'org-1',
                {
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    email: 'jane@example.com',
                    address,
                },
                null,
            );

            expect(result).toBe('cust-4');
            expect(dataSource.query.mock.calls[0][0]).toContain(
                'ON CONFLICT (organisation_id, lower(customer_phone)) WHERE customer_phone IS NOT NULL',
            );
            expect(stripe.customers.create).not.toHaveBeenCalled();
            expect(orgs.getStripeAccount).not.toHaveBeenCalled();
        });

        it('falls back to the email tier, scoped to phone-less rows, when phone is absent', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-5' }]);

            await service.upsertFromShopifyOrder(
                'org-1',
                {
                    name: 'Jane Doe',
                    phone: null,
                    email: 'jane@example.com',
                    address,
                },
                null,
            );

            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain(
                'ON CONFLICT (organisation_id, lower(customer_email)) WHERE customer_email IS NOT NULL AND customer_phone IS NULL',
            );
            expect(params).toEqual(
                expect.arrayContaining([
                    'org-1',
                    'Jane Doe',
                    null,
                    'jane@example.com',
                ]),
            );
        });

        it('falls back to the name tier, scoped to phone-less and email-less rows, when both are absent', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-6' }]);

            await service.upsertFromShopifyOrder(
                'org-1',
                { name: 'Jane Doe', phone: null, email: null, address },
                null,
            );

            const [sql] = dataSource.query.mock.calls[0];
            expect(sql).toContain(
                'ON CONFLICT (organisation_id, lower(customer_name)) WHERE customer_name IS NOT NULL AND customer_phone IS NULL AND customer_email IS NULL',
            );
        });

        it('sets shopify_customer_id via a follow-up update when provided', async () => {
            dataSource.query
                .mockResolvedValueOnce([{ id: 'cust-7' }]) // upsert
                .mockResolvedValueOnce([]); // shopify_customer_id update

            await service.upsertFromShopifyOrder(
                'org-1',
                { name: 'Jane Doe', phone: '+61400000000', address },
                'shopify-cust-999',
            );

            expect(dataSource.query).toHaveBeenCalledTimes(2);
            const [updateSql, updateParams] = dataSource.query.mock.calls[1];
            expect(updateSql).toContain('SET shopify_customer_id = $1');
            expect(updateParams).toEqual(['shopify-cust-999', 'cust-7']);
        });

        it('skips the follow-up update when no shopify customer id is given', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-8' }]);

            await service.upsertFromShopifyOrder(
                'org-1',
                { name: 'Jane Doe', phone: '+61400000000', address },
                null,
            );

            expect(dataSource.query).toHaveBeenCalledTimes(1);
        });

        it('passes geocode provenance through and preserves it via COALESCE on conflict', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-9' }]);

            await service.upsertFromShopifyOrder(
                'org-1',
                {
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    address,
                    confidence: 0.92,
                    peliasGid: 'gid-1',
                    peliasRaw: { source: 'pelias' },
                },
                null,
            );

            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain(
                'geocode_confidence = COALESCE(EXCLUDED.geocode_confidence, public.customer.geocode_confidence)',
            );
            expect(sql).toContain(
                'pelias_gid = COALESCE(EXCLUDED.pelias_gid, public.customer.pelias_gid)',
            );
            expect(sql).toContain(
                'pelias_raw = COALESCE(EXCLUDED.pelias_raw, public.customer.pelias_raw)',
            );
            expect(params).toEqual(
                expect.arrayContaining([
                    0.92,
                    'gid-1',
                    JSON.stringify({ source: 'pelias' }),
                ]),
            );
        });
    });
});
