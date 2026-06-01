import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Organisation } from './organisation.entity';
import { OrganisationStripeAccount } from './organisation-stripe-account.entity';

export interface ConnectStatusUpdate {
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    cardIssuingStatus: string | null;
}

export interface OrgIssuingStatus {
    slug: string;
    cardIssuingStatus: string | null;
    detailsSubmitted: boolean;
}

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
        country: string,
        currency: string,
    ): Promise<OrganisationStripeAccount> {
        await this.stripeRepo.upsert(
            {
                organisationId,
                stripeAccountId,
                stripeAccountCountry: country,
                stripeDefaultCurrency: currency,
            },
            { conflictPaths: ['organisationId'] },
        );
        return this.stripeRepo.findOneOrFail({ where: { organisationId } });
    }

    /**
     * Sync Connect account capability flags driven by the account.updated webhook.
     * Stamps onboarded_at the first time card_issuing becomes active.
     */
    async updateConnectStatus(
        stripeAccountId: string,
        update: ConnectStatusUpdate,
    ): Promise<void> {
        const stripe = await this.findByStripeAccountId(stripeAccountId);
        if (!stripe) return;

        stripe.detailsSubmitted = update.detailsSubmitted;
        stripe.chargesEnabled = update.chargesEnabled;
        stripe.payoutsEnabled = update.payoutsEnabled;
        stripe.cardIssuingStatus = update.cardIssuingStatus;
        if (update.cardIssuingStatus === 'active' && !stripe.onboardedAt) {
            stripe.onboardedAt = new Date();
        }
        await this.stripeRepo.save(stripe);
    }

    /**
     * Return card-issuing status flags for all orgs the user is a member of.
     * Used by the org switcher to display Connect state without PostgREST
     * touching the stripe schema.
     */
    async getAllIssuingStatuses(userId: string): Promise<OrgIssuingStatus[]> {
        const rows: { slug: string; card_issuing_status: string | null; details_submitted: boolean }[] =
            await this.dataSource.query(
                `SELECT o.slug,
                        sa.card_issuing_status,
                        COALESCE(sa.details_submitted, false) AS details_submitted
                   FROM public.organisations o
                  INNER JOIN public.user_permission up ON up.organisation_id = o.id
                   LEFT JOIN stripe.organisation_accounts sa ON sa.organisation_id = o.id
                  WHERE up.user_id = $1`,
                [userId],
            );

        return rows.map((r) => ({
            slug: r.slug,
            cardIssuingStatus: r.card_issuing_status,
            detailsSubmitted: r.details_submitted,
        }));
    }
}
