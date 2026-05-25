import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity('issuing_cardholders')
export class IssuingCardholder {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'driver_id', type: 'uuid' })
    driverId: string;

    @Column({ name: 'stripe_cardholder_id', type: 'text' })
    stripeCardholderId: string;

    @Column({ type: 'text', default: 'active' })
    status: string;

    @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;
}
