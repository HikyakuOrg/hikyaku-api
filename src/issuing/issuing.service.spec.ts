import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { IssuingService } from './issuing.service';
import { IssuingCardholder } from './entities/issuing-cardholder.entity';
import { IssuingCard } from './entities/issuing-card.entity';
import { IssuingTransaction } from './entities/issuing-transaction.entity';

function makeInsertQb() {
    const qb = {
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
    };
    return qb;
}

describe('IssuingService', () => {
    let service: IssuingService;
    let stripe: {
        issuing: {
            cardholders: { create: jest.Mock };
            cards: { create: jest.Mock; update: jest.Mock };
        };
        ephemeralKeys: { create: jest.Mock };
    };
    let supabase: { auth: { admin: { getUserById: jest.Mock } } };
    let cardholderRepo: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
    let cardRepo: {
        findOne: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
        update: jest.Mock;
        find: jest.Mock;
    };
    let txnRepo: { createQueryBuilder: jest.Mock };
    let dataSource: { query: jest.Mock };

    beforeEach(async () => {
        stripe = {
            issuing: {
                cardholders: { create: jest.fn() },
                cards: { create: jest.fn(), update: jest.fn() },
            },
            ephemeralKeys: { create: jest.fn() },
        };
        supabase = { auth: { admin: { getUserById: jest.fn() } } };
        cardholderRepo = {
            findOne: jest.fn(),
            create: jest.fn().mockImplementation((v: unknown) => v),
            save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
        };
        cardRepo = {
            findOne: jest.fn(),
            create: jest.fn().mockImplementation((v: unknown) => v),
            save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
            update: jest.fn().mockResolvedValue({}),
            find: jest.fn().mockResolvedValue([]),
        };
        txnRepo = { createQueryBuilder: jest.fn() };
        dataSource = { query: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IssuingService,
                { provide: STRIPE_CLIENT, useValue: stripe },
                { provide: SUPABASE_CLIENT, useValue: supabase },
                { provide: getRepositoryToken(IssuingCardholder), useValue: cardholderRepo },
                { provide: getRepositoryToken(IssuingCard), useValue: cardRepo },
                { provide: getRepositoryToken(IssuingTransaction), useValue: txnRepo },
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();

        service = module.get<IssuingService>(IssuingService);
    });

    describe('ensureCardholder', () => {
        it('returns the existing cardholder without calling Stripe', async () => {
            cardholderRepo.findOne.mockResolvedValue({
                id: 'ch1',
                stripeCardholderId: 'ich_existing',
            });

            const result = await service.ensureCardholder('org1', 'd1');

            expect(result.stripeCardholderId).toBe('ich_existing');
            expect(stripe.issuing.cardholders.create).not.toHaveBeenCalled();
        });

        it('creates a Stripe cardholder using the driver identity + warehouse billing address', async () => {
            cardholderRepo.findOne.mockResolvedValue(null);
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

            const result = await service.ensureCardholder('org1', 'd1');

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
                }),
            );
            expect(result.stripeCardholderId).toBe('ich_new');
        });
    });

    describe('issueCard', () => {
        beforeEach(() => {
            cardholderRepo.findOne.mockResolvedValue({
                id: 'ch1',
                stripeCardholderId: 'ich_1',
            });
        });

        it('restricts the card to fuel categories and applies the spend limit', async () => {
            dataSource.query.mockResolvedValue([{ id: 'v1' }]); // assertVehicleInOrg
            stripe.issuing.cards.create.mockResolvedValue({
                id: 'ic_1',
                last4: '4242',
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
                                amount: 15000, // $150.00 in minor units
                                interval: 'daily',
                                categories: [
                                    'automated_fuel_dispensers',
                                    'service_stations',
                                ],
                            }),
                        ],
                    }),
                }),
            );
            expect(card.stripeCardId).toBe('ic_1');
            expect(card.last4).toBe('4242');
            expect(card.spendingLimitMinor).toBe(15000);
        });

        it('omits spending_limits when no limit is given', async () => {
            stripe.issuing.cards.create.mockResolvedValue({ id: 'ic_2' });

            await service.issueCard('org1', { driverId: 'd1', currency: 'usd' });

            const params = stripe.issuing.cards.create.mock.calls[0][0];
            expect(params.spending_controls.spending_limits).toBeUndefined();
            expect(params.spending_controls.allowed_categories).toEqual([
                'automated_fuel_dispensers',
                'service_stations',
            ]);
        });
    });

    describe('recordTransaction', () => {
        it('maps a settled transaction to the ledger with the magnitude amount and resolved driver', async () => {
            cardRepo.findOne.mockResolvedValue({
                id: 'card1',
                cardholderId: 'ch1',
                vehicleId: 'v1',
                organisationId: 'org1',
            });
            cardholderRepo.findOne.mockResolvedValue({ id: 'ch1', driverId: 'd1' });
            const qb = makeInsertQb();
            txnRepo.createQueryBuilder.mockReturnValue(qb);

            await service.recordTransaction({
                id: 'ipi_1',
                type: 'capture',
                amount: -5000, // Issuing reports spend as negative
                currency: 'usd',
                card: 'ic_1',
                authorization: 'iauth_1',
                created: 1_700_000_000,
                merchant_data: {
                    name: 'Shell',
                    category: 'service_stations',
                    city: 'KL',
                    country: 'MY',
                },
            });

            expect(qb.values).toHaveBeenCalledWith(
                expect.objectContaining({
                    organisationId: 'org1',
                    cardId: 'card1',
                    cardholderId: 'ch1',
                    vehicleId: 'v1',
                    driverId: 'd1',
                    stripeTransactionId: 'ipi_1',
                    stripeAuthorizationId: 'iauth_1',
                    type: 'capture',
                    amountMinor: 5000,
                    currency: 'usd',
                    merchantName: 'Shell',
                    merchantCategory: 'service_stations',
                }),
            );
            expect(qb.orIgnore).toHaveBeenCalled(); // idempotent on stripe_transaction_id
            expect(qb.execute).toHaveBeenCalled();
        });

        it('skips a transaction that references an unknown card', async () => {
            cardRepo.findOne.mockResolvedValue(null);

            await service.recordTransaction({
                id: 'ipi_2',
                amount: -100,
                currency: 'usd',
                card: 'ic_unknown',
            });

            expect(txnRepo.createQueryBuilder).not.toHaveBeenCalled();
        });
    });

    describe('setCardStatus', () => {
        it('updates Stripe and persists the new status', async () => {
            cardRepo.findOne.mockResolvedValue({
                id: 'card1',
                stripeCardId: 'ic_1',
                organisationId: 'org1',
                status: 'active',
            });

            const result = await service.setCardStatus('org1', 'card1', 'inactive');

            expect(stripe.issuing.cards.update).toHaveBeenCalledWith('ic_1', {
                status: 'inactive',
            });
            expect(result.status).toBe('inactive');
        });
    });
});
