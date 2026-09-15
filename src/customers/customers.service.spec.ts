import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { CustomersService } from './customers.service';

describe('CustomersService', () => {
    let service: CustomersService;
    let stripe: { customers: { create: jest.Mock; update: jest.Mock } };
    let dataSource: {
        query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
    };
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
        dataSource = {
            query: jest.fn<Promise<unknown[]>, [string, unknown[]?]>(),
        };
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

        it('never issues an external_customer_id update', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-3' }]);

            await service.upsertFromBooking(
                { name: 'Amy Lee', phone: '+61400000002', address },
                null,
                'org-1',
                'idem-key-3',
            );

            for (const [sql] of dataSource.query.mock.calls) {
                expect(sql).not.toContain('external_customer_id');
            }
        });

        it('threads a supplied unit into the upsert and Stripe line2, with overwrite (not COALESCE) semantics', async () => {
            dataSource.query
                .mockResolvedValueOnce([{ id: 'cust-10' }])
                .mockResolvedValueOnce([]);
            stripe.customers.create.mockResolvedValue({ id: 'stripe-cust-10' });

            await service.upsertFromBooking(
                {
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    address: { ...address, unit: 'Unit 5' },
                },
                'acct_1',
                'org-1',
                'idem-key-10',
            );

            const [insertSql, insertParams] = dataSource.query.mock.calls[0];
            expect(insertSql).toContain(
                'customer_unit = EXCLUDED.customer_unit',
            );
            expect(insertSql).not.toContain('customer_unit = COALESCE');
            expect(insertParams[6]).toBe('Unit 5');
            expect(stripe.customers.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    address: {
                        line1: '123 Example St',
                        line2: 'Unit 5',
                        city: 'Melbourne',
                        state: 'VIC',
                        postal_code: '3000',
                        country: 'AU',
                    },
                }),
                { stripeAccount: 'acct_1', idempotencyKey: 'idem-key-10' },
            );
        });

        it('normalizes an empty-string unit to null, never persisting a blank', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-11' }]);

            await service.upsertFromBooking(
                {
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    address: { ...address, unit: '   ' },
                },
                null,
                'org-1',
                'idem-key-11',
            );

            expect(dataSource.query.mock.calls[0][1][6]).toBeNull();
        });
    });

    describe('upsertFromExternalOrder', () => {
        it('targets the phone tier when phone is present, and never touches Stripe', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-4' }]);

            const result = await service.upsertFromExternalOrder(
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

            await service.upsertFromExternalOrder(
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

            await service.upsertFromExternalOrder(
                'org-1',
                { name: 'Jane Doe', phone: null, email: null, address },
                null,
            );

            const [sql] = dataSource.query.mock.calls[0];
            expect(sql).toContain(
                'ON CONFLICT (organisation_id, lower(customer_name)) WHERE customer_name IS NOT NULL AND customer_phone IS NULL AND customer_email IS NULL',
            );
        });

        it('sets external_platform and external_customer_id via a follow-up update when provided', async () => {
            dataSource.query
                .mockResolvedValueOnce([{ id: 'cust-7' }]) // upsert
                .mockResolvedValueOnce([]); // external id update

            await service.upsertFromExternalOrder(
                'org-1',
                { name: 'Jane Doe', phone: '+61400000000', address },
                { platform: 'shopify', externalCustomerId: 'shopify-cust-999' },
            );

            expect(dataSource.query).toHaveBeenCalledTimes(2);
            const [updateSql, updateParams] = dataSource.query.mock.calls[1];
            expect(updateSql).toContain(
                'SET external_platform = $1, external_customer_id = $2',
            );
            expect(updateParams).toEqual([
                'shopify',
                'shopify-cust-999',
                'cust-7',
            ]);
        });

        it('skips the follow-up update when no external identity is given', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-8' }]);

            await service.upsertFromExternalOrder(
                'org-1',
                { name: 'Jane Doe', phone: '+61400000000', address },
                null,
            );

            expect(dataSource.query).toHaveBeenCalledTimes(1);
        });

        it('passes geocode provenance through and preserves it via COALESCE on conflict', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-9' }]);

            await service.upsertFromExternalOrder(
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

        it('persists a supplied unit when provided (line2/company fold-in)', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: 'cust-12' }]);

            await service.upsertFromExternalOrder(
                'org-1',
                {
                    name: 'Jane Doe',
                    phone: '+61400000000',
                    address: { ...address, unit: 'Suite 12, Acme Tower' },
                },
                null,
            );

            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain('customer_unit = EXCLUDED.customer_unit');
            expect(params[6]).toBe('Suite 12, Acme Tower');
        });
    });

    describe('createCustomer / updateCustomer', () => {
        const dbRow = {
            id: 'cust-13',
            organisation_id: 'org-1',
            stripe_customer_id: null,
            external_platform: null,
            external_customer_id: null,
            customer_name: 'Jane Doe',
            customer_phone: '+61400000000',
            customer_email: 'jane@example.com',
            customer_address: '123 Example St',
            customer_unit: 'Unit 5',
            customer_suburb: 'Melbourne',
            customer_state: 'VIC',
            customer_postcode: '3000',
            customer_country: 'AU',
            geocode_confidence: null,
            pelias_gid: null,
            pelias_raw: null,
            customer_location: null,
            created_at: '2026-09-06T00:00:00Z',
        };

        const dto = {
            name: 'Jane Doe',
            phone: '+61400000000',
            email: 'jane@example.com',
            address: {
                street: '123 Example St',
                unit: 'Unit 5',
                suburb: 'Melbourne',
                state: 'VIC',
                postcode: '3000',
                country: 'AU',
            },
            lat: -37.8,
            lon: 144.9,
        };

        it('inserts and returns a supplied unit (POST /customers)', async () => {
            dataSource.query.mockResolvedValueOnce([dbRow]);
            orgs.getStripeAccount.mockResolvedValue(null);

            const result = await service.createCustomer('org-1', dto);

            const [insertSql, insertParams] = dataSource.query.mock.calls[0];
            expect(insertSql).toContain('customer_unit');
            expect(insertParams[6]).toBe('Unit 5');
            expect(result.customer_unit).toBe('Unit 5');
        });

        it('clears the unit when the replacement body omits it (PUT /customers)', async () => {
            dataSource.query
                .mockResolvedValueOnce([{ stripe_customer_id: null }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ ...dbRow, customer_unit: null }]);
            orgs.getStripeAccount.mockResolvedValue(null);

            const result = await service.updateCustomer('org-1', 'cust-13', {
                ...dto,
                address: { ...dto.address, unit: undefined },
            });

            const [updateSql, updateParams] = dataSource.query.mock.calls[1];
            expect(updateSql).toContain('customer_unit = $5');
            // Omitted unit is a full replacement: the column is cleared to
            // NULL, never filled with ''.
            expect(updateParams[4]).toBeNull();
            expect(result.customer_unit).toBe('');
        });
    });
});
