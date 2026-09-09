import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A shift.
 *
 * The table is named for the solver artefact it started as, but since
 * AddShiftLifecycleColumns the row carries the shift itself: which driver, which
 * van, which depot, which day, and where it is in its lifecycle. The `request` /
 * `response` blobs are still the last solve's audit snapshot.
 *
 * Every INSERT here bills a shift through enforce_shift_allowance(). Replanning
 * only ever UPDATEs.
 */
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

    /** 'planned' | 'dispatched' | 'completed' | 'cancelled'. */
    @Column({ type: 'text', default: 'planned' })
    status: string;

    @Column({ name: 'driver_id', type: 'uuid', nullable: true })
    driverId: string | null;

    @Column({ name: 'vehicle_id', type: 'uuid', nullable: true })
    vehicleId: string | null;

    @Column({ name: 'warehouse_id', type: 'uuid', nullable: true })
    warehouseId: string | null;

    /** Warehouse-local service day, as YYYY-MM-DD. */
    @Column({ name: 'shift_date', type: 'date', nullable: true })
    shiftDate: string | null;

    @Column({ name: 'dispatched_at', type: 'timestamptz', nullable: true })
    dispatchedAt: Date | null;

    @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
    completedAt: Date | null;

    /** Bumped by the vrp_optimization_touch trigger on every UPDATE. */
    @Column({ type: 'int', default: 1 })
    revision: number;

    @Column({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;
}
