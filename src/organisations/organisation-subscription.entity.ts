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

    /**
     * Synced from the `customer.updated` webhook. Read by the
     * `enforce_shift_allowance` DB trigger (AddShiftUsageMetering) to decide
     * whether an org past its free shift allowance may keep going as billable
     * overage, or must be blocked until a card is on file.
     */
    @Column({ name: 'has_payment_method', type: 'boolean', default: false })
    hasPaymentMethod: boolean;

    /**
     * Synced from the `entitlements.active_entitlement_summary.updated`
     * webhook (and eagerly once at subscription provisioning). Read by
     * `get_booking_organisation()`/`get_tracking_details()` to decide whether
     * a company org's `vanity_slug` host currently resolves.
     */
    @Column({ name: 'has_vanity_url_entitlement', type: 'boolean', default: false })
    hasVanityUrlEntitlement: boolean;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
