import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { IssuingService } from './issuing.service';
import { IssuingCard } from './entities/issuing-card.entity';
import { OrganisationsService } from 'src/organisations/organisations.service';

describe('IssuingService', () => {
    let service: IssuingService;
    let stripe: {
        issuing: {
            cardholders: { create: jest.Mock };
            cards: { list: jest.Mock; create: jest.Mock; update: jest.Mock; retrieve: jest.Mock };
            transactions: { list: jest.Mock };
        };
        ephemeralKeys: { create: jest.Mock };
    };
    let supabase: { auth: { admin: { getUserById: jest.Mock } } };
    let cardRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
    let dataSource: { query: jest.Mock };
    let orgs: { getOrFail: jest.Mock };

    beforeEach(async () => {
        stripe = {
            issuing: {
                cardholders: { create: jest.fn() },
                cards: { list: jest.fn(), create: jest.fn(), update: jest.fn(), retrieve: jest.fn() },
                transactions: { list: jest.fn() },
            },
            ephemeralKeys: { create: jest.fn() },
        };
        supabase = { auth: { admin: { getUserById: jest.fn() } } };
        cardRepo = {
            findOne: jest.fn(),
            create: jest.fn().mockImplementation((v: unknown) => v),
            save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
        };
        dataSource = { query: jest.fn() };
        orgs = {
            getOrFail: jest.fn().mockResolvedValue({
                id: 'org1',
                stripeAccountId: 'acct_1',
                cardIssuingStatus: 'active',
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IssuingService,
                { provide: STRIPE_CLIENT, useValue: stripe },
                { provide: SUPABASE_CLIENT, useValue: supabase },
                { provide: getRepositoryToken(IssuingCard), useValue: cardRepo },
                { provide: getDataSourceToken(), useValue: dataSource },
                { provide: OrganisationsService, useValue: orgs },
            ],
        }).compile();

        service = module.get<IssuingService>(IssuingService);
    });

    describe('ensureCardholder', () => {
        it('retrieves the existing card from Stripe to read back the cardholder id (DB hit)', async () => {
            cardRepo.findOne.mockResolvedValue({ stripeCardId: 'ic_existing' });
            stripe.issuing.cards.retrieve.mockResolvedValue({
                id: 'ic_existing',
                cardholder: 'ich_existing',
            });

            const result = await service.ensureCardholder('org1', 'd1', 'acct_1');

            expect(result).toBe('ich_existing');
            expect(stripe.issuing.cards.retrieve).toHaveBeenCalledWith(
                'ic_existing',
                {},
                { stripeAccount: 'acct_1' },
            );
            expect(stripe.issuing.cardholders.create).not.toHaveBeenCalled();
        });

        it('creates a new Stripe cardholder with org+driver metadata when no DB row exists', async () => {
            cardRepo.findOne.mockResolvedValue(null);
            supabase.auth.admin.getUserById.mockResolvedValue({
                data: {
                    user: {
                        id: 'd1',
                        email: 'driver@example.com',
                        phone: '+60123456789',
                        user_metadata: { display_name: 'Drive R' },
                    },
                },
                error: null,
            });
            dataSource.query.mockResolvedValue([
                {
                    warehouse_address: '1 Jalan Test',
                    warehouse_city: 'Kuala Lumpur',
                    warehouse_state: 'WP',
                    warehouse_zipcode: '50000',
                    warehouse_country: 'MY',
                },
            ]);
            stripe.issuing.cardholders.create.mockResolvedValue({ id: 'ich_new' });

            const result = await service.ensureCardholder('org1', 'd1', 'acct_1');

            expect(stripe.issuing.cardholders.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'individual',
                    name: 'Drive R',
                    email: 'driver@example.com',
                    billing: {
                        address: expect.objectContaining({
                            line1: '1 Jalan Test',
                            city: 'Kuala Lumpur',
                            country: 'MY',
                        }),
                    },
                    metadata: { organisationId: 'org1', driverId: 'd1' },
                }),
                { stripeAccount: 'acct_1' },
            );
            expect(result).toBe('ich_new');
        });
    });

    describe('issueCard', () => {
        beforeEach(() => {
            // Driver already has a card row → DB returns existing card id,
            // then we retrieve it from Stripe to get the cardholder id.
            cardRepo.findOne.mockResolvedValue({ stripeCardId: 'ic_prev' });
            stripe.issuing.cards.retrieve.mockResolvedValue({
                id: 'ic_prev',
                cardholder: 'ich_1',
            });
        });

        it('restricts the card to fuel categories, applies the spend limit, and tags org/driver/vehicle in metadata', async () => {
            dataSource.query.mockResolvedValue([{ id: 'v1' }]); // assertVehicleInOrg
            stripe.issuing.cards.create.mockResolvedValue({
                id: 'ic_1',
                last4: '4242',
                cardholder: { id: 'ich_1' },
                type: 'virtual',
                currency: 'usd',
                status: 'active',
                created: 1_700_000_000,
                spending_controls: {
                    spending_limits: [
                        {
                            amount: 15000,
                            interval: 'daily',
                        },
                    ],
                },
                metadata: { organisationId: 'org1', driverId: 'd1', vehicleId: 'v1' },
            });

            const card = await service.issueCard('org1', {
                driverId: 'd1',
                vehicleId: 'v1',
                spendingLimitMajor: 150,
                currency: 'usd',
            });

            expect(stripe.issuing.cards.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardholder: 'ich_1',
                    currency: 'usd',
                    type: 'virtual',
                    status: 'active',
                    spending_controls: expect.objectContaining({
                        allowed_categories: [
                            'automated_fuel_dispensers',
                            'service_stations',
                        ],
                        spending_limits: [
                            expect.objectContaining({
                                amount: 15000,
                                interval: 'daily',
                                categories: [
                                    'automated_fuel_dispensers',
                                    'service_stations',
                                ],
                            }),
                        ],
                    }),
                    metadata: {
                        organisationId: 'org1',
                        driverId: 'd1',
                        vehicleId: 'v1',
                    },
                }),
                { stripeAccount: 'acct_1' },
            );
            expect(card.id).toBe('ic_1');
            expect(card.stripeCardId).toBe('ic_1');
            expect(card.last4).toBe('4242');
            expect(card.vehicleId).toBe('v1');
            expect(card.spendingLimitMinor).toBe(15000);
            expect(card.spendingInterval).toBe('daily');

            // mapping row persisted
            expect(cardRepo.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    organisationId: 'org1',
                    driverId: 'd1',
                    stripeCardId: 'ic_1',
                }),
            );
        });

        it('omits spending_limits and vehicleId metadata when neither is provided', async () => {
            stripe.issuing.cards.create.mockResolvedValue({
                id: 'ic_2',
                cardholder: 'ich_1',
                type: 'virtual',
                currency: 'usd',
                status: 'active',
                created: 1_700_000_000,
                spending_controls: {},
                metadata: { organisationId: 'org1', driverId: 'd1' },
            });

            await service.issueCard('org1', { driverId: 'd1', currency: 'usd' });

            const params = stripe.issuing.cards.create.mock.calls[0][0];
            expect(params.spending_controls.spending_limits).toBeUndefined();
            expect(params.spending_controls.allowed_categories).toEqual([
                'automated_fuel_dispensers',
                'service_stations',
            ]);
            expect(params.metadata).toEqual({
                organisationId: 'org1',
                driverId: 'd1',
            });
            expect(cardRepo.save).toHaveBeenCalledWith(
                expect.objectContaining({
                    organisationId: 'org1',
                    driverId: 'd1',
                    stripeCardId: 'ic_2',
                }),
            );
        });
    });

    describe('listCards', () => {
        it('returns an empty array when the org has no active Stripe issuing', async () => {
            orgs.getOrFail.mockResolvedValue({
                id: 'org1',
                stripeAccountId: null,
                cardIssuingStatus: null,
            });

            const result = await service.listCards('org1');

            expect(result).toEqual([]);
            expect(stripe.issuing.cards.list).not.toHaveBeenCalled();
        });

        it('maps each Stripe card to the wire DTO', async () => {
            stripe.issuing.cards.list.mockResolvedValue({
                data: [
                    {
                        id: 'ic_1',
                        last4: '4242',
                        cardholder: 'ich_1',
                        type: 'virtual',
                        currency: 'usd',
                        status: 'active',
                        created: 1_700_000_000,
                        spending_controls: {
                            spending_limits: [{ amount: 10000, interval: 'daily' }],
                        },
                        metadata: { vehicleId: 'v1' },
                    },
                ],
            });

            const result = await service.listCards('org1');

            expect(stripe.issuing.cards.list).toHaveBeenCalledWith(
                { limit: 100 },
                { stripeAccount: 'acct_1' },
            );
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                id: 'ic_1',
                organisationId: 'org1',
                stripeCardId: 'ic_1',
                vehicleId: 'v1',
                last4: '4242',
                status: 'active',
                spendingLimitMinor: 10000,
                spendingInterval: 'daily',
            });
        });
    });

    describe('listTransactions', () => {
        const txn = {
            id: 'ipi_1',
            type: 'capture',
            amount: -5000, // Issuing reports spend as negative
            currency: 'usd',
            card: {
                id: 'ic_1',
                metadata: { vehicleId: 'v1' },
            },
            cardholder: {
                id: 'ich_1',
                metadata: { driverId: 'd1' },
            },
            authorization: 'iauth_1',
            created: 1_700_000_000,
            merchant_data: {
                name: 'Shell',
                category: 'service_stations',
                city: 'KL',
                country: 'MY',
            },
        };

        it('returns an empty array when the org has no active Stripe issuing', async () => {
            orgs.getOrFail.mockResolvedValue({
                id: 'org1',
                stripeAccountId: null,
                cardIssuingStatus: null,
            });

            const result = await service.listTransactions('org1');

            expect(result).toEqual([]);
        });

        it('maps each Stripe transaction to the wire DTO with magnitude amount and resolved driver/vehicle', async () => {
            stripe.issuing.transactions.list.mockResolvedValue({ data: [txn] });

            const result = await service.listTransactions('org1');

            expect(stripe.issuing.transactions.list).toHaveBeenCalledWith(
                {
                    limit: 100,
                    expand: ['data.card', 'data.cardholder'],
                },
                { stripeAccount: 'acct_1' },
            );
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                id: 'ipi_1',
                organisationId: 'org1',
                cardId: 'ic_1',
                cardholderId: 'ich_1',
                vehicleId: 'v1',
                driverId: 'd1',
                stripeAuthorizationId: 'iauth_1',
                type: 'capture',
                amountMinor: 5000,
                currency: 'usd',
                merchantName: 'Shell',
                merchantCategory: 'service_stations',
            });
        });

        it('filters by driverId via cardholder metadata', async () => {
            stripe.issuing.transactions.list.mockResolvedValue({
                data: [
                    txn,
                    {
                        ...txn,
                        id: 'ipi_2',
                        cardholder: { id: 'ich_2', metadata: { driverId: 'd2' } },
                    },
                ],
            });

            const result = await service.listTransactions('org1', {
                driverId: 'd1',
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('ipi_1');
        });

        it('filters by vehicleId via card metadata', async () => {
            stripe.issuing.transactions.list.mockResolvedValue({
                data: [
                    txn,
                    {
                        ...txn,
                        id: 'ipi_3',
                        card: { id: 'ic_2', metadata: { vehicleId: 'v2' } },
                    },
                ],
            });

            const result = await service.listTransactions('org1', {
                vehicleId: 'v1',
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('ipi_1');
        });
    });

    describe('setCardStatus', () => {
        it('updates Stripe with the new status and returns the mapped DTO', async () => {
            stripe.issuing.cards.update.mockResolvedValue({
                id: 'ic_1',
                last4: '4242',
                cardholder: 'ich_1',
                type: 'virtual',
                currency: 'usd',
                status: 'inactive',
                created: 1_700_000_000,
                spending_controls: {},
                metadata: {},
            });

            const result = await service.setCardStatus('org1', 'ic_1', 'inactive');

            expect(stripe.issuing.cards.update).toHaveBeenCalledWith(
                'ic_1',
                { status: 'inactive' },
                { stripeAccount: 'acct_1' },
            );
            expect(result.status).toBe('inactive');
            expect(result.id).toBe('ic_1');
        });
    });
});
