import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only history of a shift's plan.
 *
 * A replan deletes every vrp_route_step on the route and re-inserts the ordered
 * list rather than renumbering in place — cheap at ≤45 steps, idempotent, and it
 * retires the two-phase negate-then-renumber both clients hand-roll. The cost is
 * that the superseded ordering is gone from vrp_route_step, so it is snapshotted
 * here first.
 */
@Entity('vrp_optimization_revision')
export class VrpOptimizationRevision {
    @PrimaryGeneratedColumn({ type: 'bigint' })
    id: string;

    @Column({ name: 'optimisation_id', type: 'uuid' })
    optimisationId: string;

    /** The vrp_optimization.revision this snapshot superseded. */
    @Column({ type: 'int' })
    revision: number;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    /** 'assign' | 'evict' | 'replan' | 'manual_add' | 'manual_remove' | 'dispatch'. */
    @Column({ type: 'text' })
    reason: string;

    /** The ordered route steps as they stood before this revision replaced them. */
    @Column({ type: 'jsonb', nullable: true })
    steps: object | null;

    @Column({ type: 'jsonb', nullable: true })
    request: object | null;

    @Column({ type: 'jsonb', nullable: true })
    response: object | null;
}
