import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One row per on-demand optimisation trigger. Backs both the per-org 5-minute
 * rate limit and the async status the dashboard polls. Written exclusively by
 * hikyaku-api over its TypeORM (service-role) connection; the dashboard only
 * SELECTs (RLS: shifts.view).
 */
export type OptimisationRunStatus =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'skipped';

@Entity('optimisation_run')
export class OptimisationRun {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ name: 'warehouse_id', type: 'uuid', nullable: true })
    warehouseId: string | null;

    @Column({ default: 'manual' })
    trigger: string;

    @Column({ name: 'requested_by', type: 'uuid', nullable: true })
    requestedBy: string | null;

    @CreateDateColumn({ name: 'requested_at' })
    requestedAt: Date;

    @Column({ default: 'queued' })
    status: OptimisationRunStatus;

    @Column({ name: 'optimisation_id', type: 'uuid', nullable: true })
    optimisationId: string | null;

    @Column({ type: 'text', nullable: true })
    error: string | null;
}
