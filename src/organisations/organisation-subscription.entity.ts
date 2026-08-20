import { Column, CreateDateColumn, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Organisation } from './organisation.entity';

/**
 * Pairs an organisation with its Stripe Billing customer + subscription — the
 * billing counterpart to OrganisationStripeAccount (Connect). Holds internal
 * Stripe object ids only; the public-safe read model (state, deadline) lives
 * on Organisation.trialEndsAt/subscriptionStatus, kept in sync by
 * BillingService from these ids and from the subscription webhook.
 */
@Entity({ schema: 'stripe', name: 'organisation_subscriptions' })
export class OrganisationSubscription {
    @PrimaryColumn({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @OneToOne(() => Organisation)
    @JoinColumn({ name: 'organisation_id' })
    organisation: Organisation;

    @Column({ name: 'stripe_customer_id', type: 'text', nullable: true })
    stripeCustomerId: string | null;

    @Column({ name: 'stripe_subscription_id', type: 'text', nullable: true })
    stripeSubscriptionId: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
