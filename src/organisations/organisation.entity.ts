import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('organisations')
export class Organisation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'text' })
    slug: string;

    @Column({ type: 'text' })
    name: string;

    @Column({ name: 'created_by', type: 'uuid' })
    createdBy: string;

    /** Stripe Connect (Custom) account id, e.g. "acct_…". Null until the org opts in. */
    @Column({ name: 'stripe_account_id', type: 'text', nullable: true })
    stripeAccountId: string | null;

    /** ISO 3166-1 alpha-2 country chosen at onboarding (orgs are global). */
    @Column({ name: 'stripe_account_country', type: 'text', nullable: true })
    stripeAccountCountry: string | null;

    @Column({ name: 'stripe_default_currency', type: 'text', nullable: true })
    stripeDefaultCurrency: string | null;

    /** Mirror of the card_issuing capability: 'inactive' | 'pending' | 'active'. */
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

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
