import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('vrp_optimization')
export class VrpOptimization {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @Column()
    provider: string;

    @Column({ type: 'jsonb' })
    request: object;

    @Column({ type: 'jsonb' })
    response: object;

    @Column({ name: 'organisation_id', type: 'uuid', nullable: true })
    organisationId: string | null;

    @Column({ name: 'scheduled_start', type: 'timestamptz', nullable: true })
    scheduledStart: Date | null;
}
