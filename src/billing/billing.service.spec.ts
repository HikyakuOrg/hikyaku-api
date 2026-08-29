import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BillingService } from './billing.service';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { Organisation } from 'src/organisations/organisation.entity';
import type { OrganisationSubscription } from 'src/organisations/organisation-subscription.entity';

const DAY = 24 * 60 * 60 * 1000;

function org(overrides: Partial<Organisation> = {}): Organisation {
    return {
        id: 'org-1',
        slug: 'acme',
        name: 'Acme',
        vanitySlug: 'acme',
        orgType: 'company',
        createdBy: 'u1',
        createdAt: new Date(),
        trialEndsAt: null,
        subscriptionStatus: null,
        ...overrides,
    };
}

function subscriptionRow(
    overrides: Partial<OrganisationSubscription> = {},
): OrganisationSubscription {
    return {
        organisationId: 'org-1',
        organisation: undefined as never,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        hasPaymentMethod: false,
        hasVanityUrlEntitlement: false,
        createdAt: new Date(),
        ...overrides,
    };
}

describe('BillingService', () => {
    let service: BillingService;
    let organisations: {
        getOrFail: jest.Mock;
        setSubscription: jest.Mock;
        updateBillingCache: jest.Mock;
        getSubscription: jest.Mock;
        updatePaymentMethodStatus: jest.Mock;
        updateVanityUrlEntitlement: jest.Mock;
        findByStripeCustomerId: jest.Mock;
    };
    let stripe: {
        prices: { list: jest.Mock };
        customers: { create: jest.Mock };
        subscriptions: { create: jest.Mock };
        subscriptionItems: { list: jest.Mock; create: jest.Mock };
        billing: { meterEvents: { create: jest.Mock } };
        billingPortal: { sessions: { create: jest.Mock } };
        entitlements: { activeEntitlements: { list: jest.Mock } };
    };
    let dsQuery: jest.Mock;

    beforeEach(async () => {
        organisations = {
            getOrFail: jest.fn(),
            setSubscription: jest.fn(),
            updateBillingCache: jest.fn(),
            getSubscription: jest.fn().mockResolvedValue(null),
            updatePaymentMethodStatus: jest.fn(),
            updateVanityUrlEntitlement: jest.fn(),
            findByStripeCustomerId: jest.fn(),
        };
        stripe = {
            prices: { list: jest.fn() },
            customers: { create: jest.fn() },
            subscriptions: { create: jest.fn() },
            subscriptionItems: {
                list: jest.fn().mockResolvedValue({ data: [] }),
                create: jest.fn(),
            },
            billing: { meterEvents: { create: jest.fn() } },
            billingPortal: { sessions: { create: jest.fn() } },
            entitlements: {
                activeEntitlements: {
                    list: jest.fn().mockResolvedValue({ data: [] }),
                },
            },
        };
        dsQuery = jest.fn().mockResolvedValue([]);
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BillingService,
                { provide: OrganisationsService, useValue: organisations },
                { provide: STRIPE_CLIENT, useValue: stripe },
                { provide: getDataSourceToken(), useValue: { query: dsQuery } },
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
            // Eager entitlement sync right after provisioning — the new
            // customer has no entitlements yet (default empty mock), so the
            // vanity host must not appear entitled before the webhook confirms it.
            expect(stripe.entitlements.activeEntitlements.list).toHaveBeenCalledWith({
                customer: 'cus_1',
            });
            expect(organisations.updateVanityUrlEntitlement).toHaveBeenCalledWith(
                'org-1',
                false,
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

    describe('getShiftUsageStatus', () => {
        it('reports usage against the personal free allowance', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'personal' }));
            dsQuery.mockResolvedValue([{ count: 12 }]);
            organisations.getSubscription.mockResolvedValue(
                subscriptionRow({ hasPaymentMethod: true }),
            );

            const status = await service.getShiftUsageStatus('org-1');

            expect(status.shiftsUsedThisPeriod).toBe(12);
            expect(status.freeAllowance).toBe(30);
            expect(status.hasPaymentMethod).toBe(true);
        });

        it('reports usage against the company free allowance, with hasPaymentMethod false when unprovisioned', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'company' }));
            dsQuery.mockResolvedValue([{ count: 601 }]);
            organisations.getSubscription.mockResolvedValue(null);

            const status = await service.getShiftUsageStatus('org-1');

            expect(status.shiftsUsedThisPeriod).toBe(601);
            expect(status.freeAllowance).toBe(600);
            expect(status.hasPaymentMethod).toBe(false);
        });
    });

    describe('reportShiftUsageBatch', () => {
        // Which rows to report, and the claim that stops two replicas reporting
        // the same ones, moved to ShiftUsageReporter. What is left here is the
        // Stripe half: make sure the organisation can be billed, then post.

        it('provisions metered-only billing for an unprovisioned personal org and posts the meter event', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'personal' }));
            organisations.getSubscription.mockResolvedValue(null);
            stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_overage' }] });
            stripe.customers.create.mockResolvedValue({ id: 'cus_new' });
            stripe.subscriptions.create.mockResolvedValue({ id: 'sub_new' });

            await service.reportShiftUsageBatch('org-1', 5, 'shift_usage_abc');

            expect(stripe.customers.create).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: { organisationId: 'org-1' } }),
            );
            expect(stripe.subscriptions.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    customer: 'cus_new',
                    items: [{ price: 'price_overage' }],
                }),
            );
            expect(organisations.setSubscription).toHaveBeenCalledWith(
                'org-1',
                'cus_new',
                'sub_new',
            );
            expect(stripe.billing.meterEvents.create).toHaveBeenCalledWith({
                event_name: 'shift_created',
                identifier: 'shift_usage_abc',
                payload: { value: '5', stripe_customer_id: 'cus_new' },
            });
        });

        it('provisions metered-only billing (no trial) for a grandfathered company org rather than calling the trial flow', async () => {
            organisations.getOrFail.mockResolvedValue(
                org({ orgType: 'company', subscriptionStatus: 'grandfathered' }),
            );
            organisations.getSubscription.mockResolvedValue(null);
            stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_overage' }] });
            stripe.customers.create.mockResolvedValue({ id: 'cus_new' });
            stripe.subscriptions.create.mockResolvedValue({ id: 'sub_new' });

            await service.reportShiftUsageBatch('org-1', 2, 'shift_usage_def');

            // Never touches the trial-subscription path — no trial_period_days,
            // no trial_settings — and never re-lists the company base price.
            expect(stripe.subscriptions.create).toHaveBeenCalledWith(
                expect.not.objectContaining({ trial_period_days: expect.anything() }),
            );
            expect(stripe.prices.list).toHaveBeenCalledWith(
                expect.objectContaining({
                    lookup_keys: ['hikyaku_organisation_shift_overage'],
                }),
            );
        });

        it('attaches the overage price to an already-provisioned subscription that lacks it', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'company' }));
            organisations.getSubscription.mockResolvedValue(subscriptionRow());
            stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_overage' }] });
            stripe.subscriptionItems.list.mockResolvedValue({ data: [] });

            await service.reportShiftUsageBatch('org-1', 1, 'shift_usage_ghi');

            expect(stripe.subscriptionItems.create).toHaveBeenCalledWith({
                subscription: 'sub_1',
                price: 'price_overage',
            });
            expect(stripe.billing.meterEvents.create).toHaveBeenCalledWith({
                event_name: 'shift_created',
                identifier: 'shift_usage_ghi',
                payload: { value: '1', stripe_customer_id: 'cus_1' },
            });
        });

        it('does not attach the overage price again when it is already on the subscription', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'company' }));
            organisations.getSubscription.mockResolvedValue(subscriptionRow());
            stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_overage' }] });
            stripe.subscriptionItems.list.mockResolvedValue({
                data: [{ price: { id: 'price_overage' } }],
            });

            await service.reportShiftUsageBatch('org-1', 1, 'shift_usage_jkl');

            expect(stripe.subscriptionItems.create).not.toHaveBeenCalled();
        });

        it('propagates a failure so the caller can release the claim', async () => {
            organisations.getOrFail.mockRejectedValue(
                new NotFoundException('Organisation not found'),
            );

            await expect(
                service.reportShiftUsageBatch('org-broken', 3, 'shift_usage_mno'),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
        });
    });

    describe('createBillingPortalSession', () => {
        it('provisions billing for an org with no Stripe presence yet, then creates a portal session', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'personal' }));
            organisations.getSubscription.mockResolvedValue(null);
            stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_overage' }] });
            stripe.customers.create.mockResolvedValue({ id: 'cus_new' });
            stripe.subscriptions.create.mockResolvedValue({ id: 'sub_new' });
            stripe.billingPortal.sessions.create.mockResolvedValue({
                url: 'https://billing.stripe.com/session/abc',
            });

            const result = await service.createBillingPortalSession(
                'org-1',
                'https://acme.hikyaku.org/dashboard/settings/billing',
            );

            expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
                customer: 'cus_new',
                return_url: 'https://acme.hikyaku.org/dashboard/settings/billing',
            });
            expect(result).toEqual({ url: 'https://billing.stripe.com/session/abc' });
        });

        it('reuses an already-provisioned customer', async () => {
            organisations.getOrFail.mockResolvedValue(org({ orgType: 'company' }));
            organisations.getSubscription.mockResolvedValue(subscriptionRow());
            stripe.prices.list.mockResolvedValue({ data: [{ id: 'price_overage' }] });
            stripe.subscriptionItems.list.mockResolvedValue({
                data: [{ price: { id: 'price_overage' } }],
            });
            stripe.billingPortal.sessions.create.mockResolvedValue({
                url: 'https://billing.stripe.com/session/xyz',
            });

            await service.createBillingPortalSession('org-1', 'https://return.example');

            expect(stripe.customers.create).not.toHaveBeenCalled();
            expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
                customer: 'cus_1',
                return_url: 'https://return.example',
            });
        });
    });

    describe('syncPaymentMethodFromStripe', () => {
        it('marks the org as having a payment method when the customer has a default one', async () => {
            await service.syncPaymentMethodFromStripe({
                id: 'cus_1',
                metadata: { organisationId: 'org-1' },
                invoice_settings: { default_payment_method: 'pm_123' },
            });

            expect(organisations.updatePaymentMethodStatus).toHaveBeenCalledWith(
                'org-1',
                true,
            );
        });

        it('marks the org as having no payment method when the default is cleared', async () => {
            await service.syncPaymentMethodFromStripe({
                id: 'cus_1',
                metadata: { organisationId: 'org-1' },
                invoice_settings: { default_payment_method: null },
            });

            expect(organisations.updatePaymentMethodStatus).toHaveBeenCalledWith(
                'org-1',
                false,
            );
        });

        it('ignores an event with no organisationId metadata', async () => {
            await service.syncPaymentMethodFromStripe({
                id: 'cus_1',
                metadata: null,
            });

            expect(organisations.updatePaymentMethodStatus).not.toHaveBeenCalled();
        });
    });

    describe('syncVanityUrlEntitlementFromStripe', () => {
        it('marks the org entitled when the vanity_url feature is in the active summary', async () => {
            organisations.findByStripeCustomerId.mockResolvedValue(
                subscriptionRow(),
            );

            await service.syncVanityUrlEntitlementFromStripe({
                customer: 'cus_1',
                entitlements: { data: [{ lookup_key: 'vanity_url' }] },
            });

            expect(organisations.updateVanityUrlEntitlement).toHaveBeenCalledWith(
                'org-1',
                true,
            );
        });

        it('marks the org unentitled when vanity_url is absent from the active summary', async () => {
            organisations.findByStripeCustomerId.mockResolvedValue(
                subscriptionRow(),
            );

            await service.syncVanityUrlEntitlementFromStripe({
                customer: 'cus_1',
                entitlements: { data: [{ lookup_key: 'plugins' }] },
            });

            expect(organisations.updateVanityUrlEntitlement).toHaveBeenCalledWith(
                'org-1',
                false,
            );
        });

        it('ignores an event for a customer with no matching organisation', async () => {
            organisations.findByStripeCustomerId.mockResolvedValue(null);

            await service.syncVanityUrlEntitlementFromStripe({
                customer: 'cus_unknown',
                entitlements: { data: [{ lookup_key: 'vanity_url' }] },
            });

            expect(organisations.updateVanityUrlEntitlement).not.toHaveBeenCalled();
        });
    });

    describe('getVanityUrlStatus', () => {
        it('is entitled when the cached flag is true', async () => {
            organisations.getOrFail.mockResolvedValue(
                org({ orgType: 'company', subscriptionStatus: 'active' }),
            );
            organisations.getSubscription.mockResolvedValue(
                subscriptionRow({ hasVanityUrlEntitlement: true }),
            );

            expect(await service.getVanityUrlStatus('org-1')).toEqual({
                hasVanityUrlEntitlement: true,
            });
        });

        it('is entitled for a grandfathered company org even with no cached flag', async () => {
            organisations.getOrFail.mockResolvedValue(
                org({ orgType: 'company', subscriptionStatus: 'grandfathered' }),
            );
            organisations.getSubscription.mockResolvedValue(null);

            expect(await service.getVanityUrlStatus('org-1')).toEqual({
                hasVanityUrlEntitlement: true,
            });
        });

        it('is not entitled once the cached flag is false and the org is not grandfathered', async () => {
            organisations.getOrFail.mockResolvedValue(
                org({ orgType: 'company', subscriptionStatus: 'canceled' }),
            );
            organisations.getSubscription.mockResolvedValue(
                subscriptionRow({ hasVanityUrlEntitlement: false }),
            );

            expect(await service.getVanityUrlStatus('org-1')).toEqual({
                hasVanityUrlEntitlement: false,
            });
        });
    });
});
