import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

/** See payment.entity.ts: bigint arrives as a string; minor-unit amounts are
 * always within Number.MAX_SAFE_INTEGER, so a Number is safe and ergonomic. */
const bigintAsNumber = {
    to: (value: number): number => value,
    from: (value: string | null): number | null =>
        value == null ? null : Number(value),
};

@Entity('issuing_transactions')
export class IssuingTransaction {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'card_id', type: 'uuid', nullable: true })
    cardId: string | null;

    @Column({ name: 'cardholder_id', type: 'uuid', nullable: true })
    cardholderId: string | null;

    @Column({ name: 'vehicle_id', type: 'uuid', nullable: true })
    vehicleId: string | null;

    @Column({ name: 'driver_id', type: 'uuid', nullable: true })
    driverId: string | null;

    @Column({ name: 'stripe_transaction_id', type: 'text' })
    stripeTransactionId: string;

    @Column({ name: 'stripe_authorization_id', type: 'text', nullable: true })
    stripeAuthorizationId: string | null;

    @Column({ type: 'text', default: 'capture' })
    type: string;

    @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintAsNumber })
    amountMinor: number;

    @Column({ type: 'text' })
    currency: string;

    @Column({ name: 'merchant_name', type: 'text', nullable: true })
    merchantName: string | null;

    @Column({ name: 'merchant_category', type: 'text', nullable: true })
    merchantCategory: string | null;

    @Column({ name: 'merchant_city', type: 'text', nullable: true })
    merchantCity: string | null;

    @Column({ name: 'merchant_country', type: 'text', nullable: true })
    merchantCountry: string | null;

    @Column({ name: 'authorized_at', type: 'timestamptz', nullable: true })
    authorizedAt: Date | null;

    @Column({ type: 'jsonb', nullable: true })
    raw: unknown;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
