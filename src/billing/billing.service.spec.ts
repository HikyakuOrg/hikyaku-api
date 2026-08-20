import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { Organisation } from 'src/organisations/organisation.entity';

const DAY = 24 * 60 * 60 * 1000;

function org(overrides: Partial<Organisation> = {}): Organisation {
    return {
        id: 'org-1',
        slug: 'acme',
        name: 'Acme',
        orgType: 'company',
        createdBy: 'u1',
        createdAt: new Date(),
        trialEndsAt: null,
        subscriptionStatus: null,
        ...overrides,
    };
}

describe('BillingService', () => {
    let service: BillingService;
    let organisations: {
        getOrFail: jest.Mock;
        setSubscription: jest.Mock;
        updateBillingCache: jest.Mock;
    };
    let stripe: {
        prices: { list: jest.Mock };
        customers: { create: jest.Mock };
        subscriptions: { create: jest.Mock };
    };

    beforeEach(async () => {
        organisations = {
            getOrFail: jest.fn(),
            setSubscription: jest.fn(),
            updateBillingCache: jest.fn(),
        };
        stripe = {
            prices: { list: jest.fn() },
            customers: { create: jest.fn() },
            subscriptions: { create: jest.fn() },
        };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BillingService,
                { provide: OrganisationsService, useValue: organisations },
                { provide: STRIPE_CLIENT, useValue: stripe },
            ],
        }).compile();
        service = module.get(BillingService);
    });

    it('reports a running trial with its deadline and day count', async () => {
        // Half a day off the boundary on purpose. An exact `now + 7 * DAY` sits
        // precisely on the floor boundary, so whether the service's own
        // `new Date()` lands in the same millisecond as the test's decides
        // between 6 and 7 — a real coin-flip failure, not a hypothetical one.
        const endsAt = new Date(Date.now() + 6 * DAY + 12 * 60 * 60 * 1000);
        organisations.getOrFail.mockResolvedValue(
            org({ subscriptionStatus: 'trialing', trialEndsAt: endsAt }),
        );

        const status = await service.getTrialStatus('org-1');

        expect(status.state).toBe('active');
        expect(status.trialEndsAt).toBe(endsAt.toISOString());
        expect(status.daysRemaining).toBe(6);
        // Already provisioned — must not touch Stripe again.
        expect(stripe.prices.list).not.toHaveBeenCalled();
    });

    it('reports a canceled subscription as expired with 0 days left', async () => {
        organisations.getOrFail.mockResolvedValue(
            org({
                subscriptionStatus: 'canceled',
                trialEndsAt: new Date(Date.now() - DAY),
            }),
        );

        const status = await service.getTrialStatus('org-1');

        expect(status.state).toBe('expired');
        expect(status.daysRemaining).toBe(0);
    });

    // A personal org never gets a Stripe subscription; the dashboard must read
    // that as "nothing to show" rather than rendering an expired banner.
    it('reports a personal org as "none" with nulls, without touching Stripe', async () => {
        organisations.getOrFail.mockResolvedValue(
            org({ orgType: 'personal', subscriptionStatus: null }),
        );

        expect(await service.getTrialStatus('org-1')).toEqual({
            state: 'none',
            trialEndsAt: null,
            daysRemaining: null,
        });
        expect(stripe.customers.create).not.toHaveBeenCalled();
    });

    // Every company org that predated Stripe billing was backfilled to this
    // sentinel and must never be silently re-enrolled into a fresh trial.
    it('reports a grandfathered company org as "none", without touching Stripe', async () => {
        organisations.getOrFail.mockResolvedValue(
            org({ subscriptionStatus: 'grandfathered' }),
        );

        expect(await service.getTrialStatus('org-1')).toEqual({
            state: 'none',
            trialEndsAt: null,
            daysRemaining: null,
        });
        expect(stripe.customers.create).not.toHaveBeenCalled();
    });

    it('propagates the 404 for an organisation that does not exist', async () => {
        organisations.getOrFail.mockRejectedValue(
            new NotFoundException('Organisation not found'),
        );

        await expect(service.getTrialStatus('nope')).rejects.toThrow(
            NotFoundException,
        );
    });

    describe('lazy provisioning', () => {
        it('creates a Stripe customer + trialing subscription for an unprovisioned company org', async () => {
            organisations.getOrFail.mockResolvedValue(
                org({ subscriptionStatus: null, trialEndsAt: null }),
            );
            stripe.prices.list.mockResolvedValue({
                data: [{ id: 'price_1', recurring: { trial_period_days: 7 } }],
            });
            stripe.customers.create.mockResolvedValue({ id: 'cus_1' });
            // Half a day of buffer past exactly 7 days, for the same reason as
            // the boundary note above: the service computes its own `now`
            // slightly after this mock is built, so an exact 7-day offset is a
            // floor-rounding coin flip between 6 and 7.
            const trialEnd =
                Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 + 12 * 60 * 60;
            stripe.subscriptions.create.mockResolvedValue({
                id: 'sub_1',
                status: 'trialing',
                trial_end: trialEnd,
            });

            const status = await service.getTrialStatus('org-1');

            expect(stripe.prices.list).toHaveBeenCalledWith(
                expect.objectContaining({
                    lookup_keys: ['hikyaku_organisation_monthly'],
                }),
            );
            expect(stripe.customers.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: { organisationId: 'org-1' },
                }),
            );
            expect(stripe.subscriptions.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    customer: 'cus_1',
                    items: [{ price: 'price_1' }],
                    trial_period_days: 7,
                }),
            );
            expect(organisations.setSubscription).toHaveBeenCalledWith(
                'org-1',
                'cus_1',
                'sub_1',
            );
            expect(organisations.updateBillingCache).toHaveBeenCalledWith(
                'org-1',
                new Date(trialEnd * 1000),
                'trialing',
            );
            expect(status.state).toBe('active');
            expect(status.daysRemaining).toBe(7);
        });

        it('throws when the organisation price has not been created in Stripe yet', async () => {
            organisations.getOrFail.mockResolvedValue(
                org({ subscriptionStatus: null }),
            );
            stripe.prices.list.mockResolvedValue({ data: [] });

            await expect(service.getTrialStatus('org-1')).rejects.toThrow(
                /No active Stripe price/,
            );
        });
    });

    describe('syncSubscriptionFromStripe', () => {
        it('updates the cached status and deadline from a webhook event', async () => {
            await service.syncSubscriptionFromStripe({
                id: 'sub_1',
                customer: 'cus_1',
                status: 'canceled',
                trial_end: null,
                metadata: { organisationId: 'org-1' },
            });

            expect(organisations.setSubscription).toHaveBeenCalledWith(
                'org-1',
                'cus_1',
                'sub_1',
            );
            expect(organisations.updateBillingCache).toHaveBeenCalledWith(
                'org-1',
                null,
                'canceled',
            );
        });

        it('resolves the customer id whether Stripe sends a string or an expanded object', async () => {
            await service.syncSubscriptionFromStripe({
                id: 'sub_1',
                customer: { id: 'cus_1' },
                status: 'active',
                trial_end: null,
                metadata: { organisationId: 'org-1' },
            });

            expect(organisations.setSubscription).toHaveBeenCalledWith(
                'org-1',
                'cus_1',
                'sub_1',
            );
        });

        it('ignores an event with no organisationId metadata', async () => {
            await service.syncSubscriptionFromStripe({
                id: 'sub_1',
                customer: 'cus_1',
                status: 'active',
                trial_end: null,
                metadata: null,
            });

            expect(organisations.setSubscription).not.toHaveBeenCalled();
            expect(organisations.updateBillingCache).not.toHaveBeenCalled();
        });
    });
});
