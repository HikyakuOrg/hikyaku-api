import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('service_rates')
export class ServiceRate {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ default: 'USD' })
    currency: string;

    @Column({ name: 'delivery_type' })
    deliveryType: string;

    @Column({ name: 'base_rate', type: 'numeric', precision: 10, scale: 2 })
    baseRate: number;

    @Column({ name: 'distance_unit', default: 'km' })
    distanceUnit: string;

    @Column({ name: 'rate_per_distance', type: 'numeric', precision: 10, scale: 4 })
    ratePerDistance: number;

    @Column({ name: 'storage_per_day', type: 'numeric', precision: 10, scale: 2, nullable: true })
    storagePerDay: number | null;

    @Column({ name: 'has_signature_charge', default: false })
    hasSignatureCharge: boolean;

    @Column({ name: 'signature_charge', type: 'numeric', precision: 10, scale: 2, nullable: true })
    signatureCharge: number | null;

    @Column({ name: 'has_out_of_area_surcharge', default: false })
    hasOutOfAreaSurcharge: boolean;

    @Column({ name: 'out_of_area_type', type: 'text', nullable: true })
    outOfAreaType: string | null;

    @Column({ name: 'out_of_area_rate', type: 'numeric', precision: 10, scale: 2, nullable: true })
    outOfAreaRate: number | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;
}
