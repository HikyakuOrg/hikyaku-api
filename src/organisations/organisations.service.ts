import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Organisation } from './organisation.entity';

export interface ConnectStatusUpdate {
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    cardIssuingStatus: string | null;
}

@Injectable()
export class OrganisationsService {
    constructor(
        @InjectRepository(Organisation)
        private readonly orgRepo: Repository<Organisation>,
    ) {}

    findById(id: string): Promise<Organisation | null> {
        return this.orgRepo.findOne({ where: { id } });
    }

    findByStripeAccountId(stripeAccountId: string): Promise<Organisation | null> {
        return this.orgRepo.findOne({ where: { stripeAccountId } });
    }

    async getOrFail(id: string): Promise<Organisation> {
        const org = await this.findById(id);
        if (!org) throw new NotFoundException('Organisation not found');
        return org;
    }

    /** Persist the newly created connected account on the org. */
    async setStripeAccount(
        id: string,
        stripeAccountId: string,
        country: string,
        currency: string,
    ): Promise<Organisation> {
        const org = await this.getOrFail(id);
        org.stripeAccountId = stripeAccountId;
        org.stripeAccountCountry = country;
        org.stripeDefaultCurrency = currency;
        return this.orgRepo.save(org);
    }

    /**
     * Sync the connected account's onboarding/capability state (driven by the
     * account.updated Connect webhook). Stamps onboarded_at the first time the
     * card_issuing capability becomes active.
     */
    async updateConnectStatus(
        stripeAccountId: string,
        update: ConnectStatusUpdate,
    ): Promise<void> {
        const org = await this.findByStripeAccountId(stripeAccountId);
        if (!org) return;

        org.detailsSubmitted = update.detailsSubmitted;
        org.chargesEnabled = update.chargesEnabled;
        org.payoutsEnabled = update.payoutsEnabled;
        org.cardIssuingStatus = update.cardIssuingStatus;
        if (update.cardIssuingStatus === 'active' && !org.onboardedAt) {
            org.onboardedAt = new Date();
        }
        await this.orgRepo.save(org);
    }
}
