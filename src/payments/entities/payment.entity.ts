import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Postgres `bigint` is returned by the driver as a string to avoid precision
 * loss. Currency minor-unit amounts are always well within Number.MAX_SAFE_INTEGER,
 * so converting to a number here is safe and far more ergonomic.
 */
const bigintAsNumber = {
    to: (value: number): number => value,
    from: (value: string | null): number | null =>
        value == null ? null : Number(value),
};

@Entity({ schema: 'stripe', name: 'payments' })
export class Payment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'package_id', type: 'uuid', nullable: true })
    packageId: string | null;

    @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintAsNumber })
    amountMinor: number;

    @Column({ type: 'text' })
    currency: string;

    @Column({ type: 'text', default: 'pending' })
    status: string;

    @Column({ name: 'organisation_id', type: 'uuid', nullable: true })
    organisationId: string | null;

    @Column({ name: 'stripe_checkout_session_id', type: 'text', nullable: true })
    stripeCheckoutSessionId: string | null;

    @Column({ name: 'stripe_payment_intent_id', type: 'text', nullable: true })
    stripePaymentIntentId: string | null;

    @Column({ name: 'booking_details', type: 'jsonb', nullable: true })
    bookingDetails: unknown;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;
}
