import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('scheduler_runs')
export class SchedulerRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'warehouse_id', type: 'uuid' })
    warehouseId: string;

    @Column({ name: 'run_date', type: 'date' })
    runDate: string;

    @CreateDateColumn({ name: 'ran_at' })
    ranAt: Date;

    @Column({ default: 'pending' })
    status: string;

    @Column({ name: 'retry_count', type: 'int', default: 0 })
    retryCount: number;
}
