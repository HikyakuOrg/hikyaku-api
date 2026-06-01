import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Organisation } from './organisation.entity';

@Entity({ schema: 'stripe', name: 'organisation_accounts' })
export class OrganisationStripeAccount {
    @PrimaryColumn({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @OneToOne(() => Organisation)
    @JoinColumn({ name: 'organisation_id' })
    organisation: Organisation;

    @Column({ name: 'stripe_account_id', type: 'text', nullable: true })
    stripeAccountId: string | null;

    @Column({ name: 'stripe_account_country', type: 'text', nullable: true })
    stripeAccountCountry: string | null;

    @Column({ name: 'stripe_default_currency', type: 'text', nullable: true })
    stripeDefaultCurrency: string | null;

    @Column({ name: 'card_issuing_status', type: 'text', nullable: true })
    cardIssuingStatus: string | null;

    @Column({ name: 'details_submitted', type: 'boolean', default: false })
    detailsSubmitted: boolean;

    @Column({ name: 'charges_enabled', type: 'boolean', default: false })
    chargesEnabled: boolean;

    @Column({ name: 'payouts_enabled', type: 'boolean', default: false })
    payoutsEnabled: boolean;

    @Column({ name: 'onboarded_at', type: 'timestamptz', nullable: true })
    onboardedAt: Date | null;
}
