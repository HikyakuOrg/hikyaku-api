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

    /**
     * Human-readable booking subdomain derived from `name`, e.g.
     * 'acme-couriers'. NULL for personal orgs and any company org whose name
     * has no sluggable characters. Set by the `set_organisation_vanity_slug`
     * DB trigger (AddOrganisationVanitySlug) on INSERT and on UPDATE OF
     * name/org_type — never written from application code. Whether it
     * currently resolves to anything depends on the org's live vanity_url
     * entitlement; see
     * `get_booking_organisation()`.
     */
    @Column({ name: 'vanity_slug', type: 'text', nullable: true })
    vanitySlug: string | null;

    /** 'personal' | 'company' — determines whether Stripe Connect onboarding is required. */
    @Column({ name: 'org_type', type: 'text', default: 'personal' })
    orgType: string;

    @Column({ name: 'created_by', type: 'uuid' })
    createdBy: string;

    /**
     * End of the 7-day company trial, stamped at INSERT by the
     * `organisations_set_trial` trigger. NULL means no trial applies — personal
     * orgs, and every org that predates the column. Read it through
     * `isTrialExpired()` rather than comparing by hand.
     */
    @Column({ name: 'trial_ends_at', type: 'timestamptz', nullable: true })
    trialEndsAt: Date | null;

    /**
     * Cached Stripe subscription status ('trialing', 'active', 'canceled', ...),
     * or the 'grandfathered' sentinel backfilled onto every company org that
     * predates Stripe billing. NULL means no Stripe subscription has been
     * provisioned yet — a personal org, or a company org
     * BillingService.ensureSubscription() has not reached yet. Synced from
     * Stripe by the subscription webhook; read through trialState() in
     * src/common/trial.ts rather than compared directly.
     */
    @Column({ name: 'subscription_status', type: 'text', nullable: true })
    subscriptionStatus: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
