import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Organisation } from './organisation.entity';
import { OrganisationStripeAccount } from './organisation-stripe-account.entity';

@Injectable()
export class OrganisationsService {
    constructor(
        @InjectRepository(Organisation)
        private readonly orgRepo: Repository<Organisation>,
        @InjectRepository(OrganisationStripeAccount)
        private readonly stripeRepo: Repository<OrganisationStripeAccount>,
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
