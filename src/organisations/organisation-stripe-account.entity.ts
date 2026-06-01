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

    @Column({ name: 'onboarded_at', type: 'timestamptz', nullable: true })
    onboardedAt: Date | null;
}
