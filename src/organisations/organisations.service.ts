import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Organisation } from './organisation.entity';
import { OrganisationStripeAccount } from './organisation-stripe-account.entity';
import { OrganisationSubscription } from './organisation-subscription.entity';

@Injectable()
export class OrganisationsService {
    constructor(
        @InjectRepository(Organisation)
        private readonly orgRepo: Repository<Organisation>,
        @InjectRepository(OrganisationStripeAccount)
        private readonly stripeRepo: Repository<OrganisationStripeAccount>,
        @InjectRepository(OrganisationSubscription)
        private readonly subscriptionRepo: Repository<OrganisationSubscription>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    findById(id: string): Promise<Organisation | null> {
        return this.orgRepo.findOne({ where: { id } });
    }

    /** Resolve an org by its public slug — used by the public booking endpoints. */
    findBySlug(slug: string): Promise<Organisation | null> {
        return this.orgRepo.findOne({ where: { slug } });
    }

    async getOrFail(id: string): Promise<Organisation> {
        const org = await this.findById(id);
        if (!org) throw new NotFoundException('Organisation not found');
        return org;
    }

    getStripeAccount(
        organisationId: string,
    ): Promise<OrganisationStripeAccount | null> {
        return this.stripeRepo.findOne({ where: { organisationId } });
    }

    findByStripeAccountId(
        stripeAccountId: string,
    ): Promise<OrganisationStripeAccount | null> {
        return this.stripeRepo.findOne({ where: { stripeAccountId } });
    }

    /**
     * Resolves an org from its Stripe Billing customer id — needed by the
     * entitlements webhook, whose payload carries only `customer`, unlike the
     * `customer.subscription.*`/`customer.updated` webhooks which carry
     * `metadata.organisationId` directly.
     */
    findByStripeCustomerId(
        stripeCustomerId: string,
    ): Promise<OrganisationSubscription | null> {
        return this.subscriptionRepo.findOne({ where: { stripeCustomerId } });
    }

    /** Upsert the satellite row when a new connected account is created. */
    async setStripeAccount(
        organisationId: string,
        stripeAccountId: string,
    ): Promise<OrganisationStripeAccount> {
        await this.stripeRepo.upsert(
            { organisationId, stripeAccountId },
            { conflictPaths: ['organisationId'] },
        );
        return this.stripeRepo.findOneOrFail({ where: { organisationId } });
    }

    /**
     * Stamps onboarded_at the first time card_issuing becomes active.
     * All other status fields are now read live from Stripe.
     */
    async stampOnboardedAt(
        stripeAccountId: string,
        cardIssuingStatus: string | null,
    ): Promise<void> {
        if (cardIssuingStatus !== 'active') return;
        const stripe = await this.findByStripeAccountId(stripeAccountId);
        if (!stripe || stripe.onboardedAt) return;
        stripe.onboardedAt = new Date();
        await this.stripeRepo.save(stripe);
    }

    /** Upsert the satellite row the first time a company org's Stripe Billing
     * customer + subscription are created. */
    async setSubscription(
        organisationId: string,
        stripeCustomerId: string,
        stripeSubscriptionId: string,
    ): Promise<void> {
        await this.subscriptionRepo.upsert(
            { organisationId, stripeCustomerId, stripeSubscriptionId },
            { conflictPaths: ['organisationId'] },
        );
    }

    /**
     * Writes the cached read model that PermissionGuard and BillingService both
     * read — see trialState() in src/common/trial.ts. Called right after
     * provisioning a subscription, and by the customer.subscription.* webhook
     * on every later status change, so the two never read a stale value.
     */
    async updateBillingCache(
        organisationId: string,
        trialEndsAt: Date | null,
        subscriptionStatus: string | null,
    ): Promise<void> {
        await this.orgRepo.update(
            { id: organisationId },
            { trialEndsAt, subscriptionStatus },
        );
    }

    /** The Stripe billing satellite row for an org, or null if never provisioned. */
    getSubscription(
        organisationId: string,
    ): Promise<OrganisationSubscription | null> {
        return this.subscriptionRepo.findOne({ where: { organisationId } });
    }

    /**
     * Synced by the `customer.updated` webhook (StripeWebhookController), keyed
     * off the customer's own `metadata.organisationId` the same way subscription
     * events already are. Read by the `enforce_shift_allowance` DB trigger.
     */
    async updatePaymentMethodStatus(
        organisationId: string,
        hasPaymentMethod: boolean,
    ): Promise<void> {
        await this.subscriptionRepo.update(
            { organisationId },
            { hasPaymentMethod },
        );
    }

    /**
     * Synced by the `entitlements.active_entitlement_summary.updated`
     * webhook (BillingService.syncVanityUrlEntitlementFromStripe), and
     * eagerly once right after a company org's Stripe customer is created.
     * Read by `get_booking_organisation()`/`get_tracking_details()` to decide
     * whether the org's vanity_slug host currently resolves.
     */
    async updateVanityUrlEntitlement(
        organisationId: string,
        hasVanityUrlEntitlement: boolean,
    ): Promise<void> {
        await this.subscriptionRepo.update(
            { organisationId },
            { hasVanityUrlEntitlement },
        );
    }

    /**
     * Return slug + stripeAccountId for all orgs the user is a member of.
     * Callers enrich with live Stripe data.
     */
    async getAccountsForUser(
        userId: string,
    ): Promise<{ slug: string; stripeAccountId: string | null }[]> {
        const rows: { slug: string; stripe_account_id: string | null }[] =
            await this.dataSource.query(
                `SELECT o.slug,
                        sa.stripe_account_id
                   FROM public.organisations o
                  INNER JOIN public.user_permission up ON up.organisation_id = o.id
                   LEFT JOIN stripe.organisation_accounts sa ON sa.organisation_id = o.id
                  WHERE up.user_id = $1`,
                [userId],
            );

        return rows.map((r) => ({
            slug: r.slug,
            stripeAccountId: r.stripe_account_id,
        }));
    }
}
