import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lean mapping table: links a local driver + organisation to their Stripe
 * card id. Card data (status, last4, currency, spend limits) is NOT stored —
 * it is fetched on demand from Stripe. This table exists so we know which
 * Stripe card belongs to which driver without querying Stripe.
 */
@Entity('issuing_cards')
export class IssuingCard {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'driver_id', type: 'uuid' })
    driverId: string;

    @Column({ name: 'stripe_card_id', type: 'text', unique: true })
    stripeCardId: string;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
