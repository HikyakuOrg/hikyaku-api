import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/** See payment.entity.ts: bigint arrives as a string; minor-unit amounts are
 * always within Number.MAX_SAFE_INTEGER, so a Number is safe and ergonomic. */
const bigintAsNumber = {
    to: (value: number | null): number | null => value,
    from: (value: string | null): number | null =>
        value == null ? null : Number(value),
};

@Entity('issuing_cards')
export class IssuingCard {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'cardholder_id', type: 'uuid' })
    cardholderId: string;

    @Column({ name: 'vehicle_id', type: 'uuid', nullable: true })
    vehicleId: string | null;

    @Column({ name: 'stripe_card_id', type: 'text' })
    stripeCardId: string;

    @Column({ type: 'text', nullable: true })
    last4: string | null;

    @Column({ type: 'text', default: 'virtual' })
    type: string;

    @Column({ type: 'text', default: 'usd' })
    currency: string;

    @Column({ type: 'text', default: 'active' })
    status: string;

    @Column({
        name: 'spending_limit_minor',
        type: 'bigint',
        nullable: true,
        transformer: bigintAsNumber,
    })
    spendingLimitMinor: number | null;

    @Column({ name: 'spending_interval', type: 'text', nullable: true })
    spendingInterval: string | null;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;
}
