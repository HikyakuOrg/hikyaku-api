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

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
