import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { QUEUE_NAME } from '../tasks/queue.service';
import type { RunOptimisationDto } from './dto/run-optimisation.dto';

/** Minimum gap between on-demand runs for a single organisation. */
const RATE_LIMIT_MINUTES = 5;

@Injectable()
export class OptimisationService {
    private readonly logger = new Logger(OptimisationService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(OptimisationRun)
        private readonly optimisationRunRepo: Repository<OptimisationRun>,
    ) { }

    /**
     * Enqueues an on-demand optimisation for the org, enforcing the 5-minute
     * rate limit atomically. A transaction-scoped advisory lock on the org
     * serialises concurrent clicks; the conditional check + INSERT + queue send
     * all commit together, so the run row can never exist without its message.
     *
     * Throws 429 (with nextAllowedAt) when a run happened in the last 5 minutes.
     */
    async triggerRun(
        organisationId: string,
        userId: string,
        dto: RunOptimisationDto,
    ): Promise<{ runId: string; status: 'queued' }> {
        // Validate the warehouse belongs to the caller's org before doing work.
        const wh: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM warehouse WHERE id = $1 AND organisation_id = $2`,
            [dto.warehouseId, organisationId],
        );
        if (wh.length === 0) {
            throw new BadRequestException('Warehouse not found for this organisation.');
        }

        const overrides = dto.setOffOverrides ?? [];

        return this.dataSource.transaction(async (em) => {
            // Serialise per-org so two simultaneous requests can't both pass the
            // rate-limit check (advisory lock auto-releases at txn end).
            await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [organisationId]);

            const recent: { requested_at: string }[] = await em.query(
                `SELECT requested_at
                 FROM optimisation_run
                 WHERE organisation_id = $1
                   AND status NOT IN ('failed', 'skipped')
                   AND requested_at > now() - make_interval(mins => $2::int)
                 ORDER BY requested_at DESC
                 LIMIT 1`,
                [organisationId, RATE_LIMIT_MINUTES],
            );

            if (recent.length > 0) {
                const nextAllowedAt = new Date(
                    new Date(recent[0].requested_at).getTime() + RATE_LIMIT_MINUTES * 60_000,
                ).toISOString();
                throw new HttpException(
                    { message: 'Optimisation was run recently. Please wait.', nextAllowedAt },
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }

            const inserted: { id: string }[] = await em.query(
                `INSERT INTO optimisation_run
                    (organisation_id, warehouse_id, requested_by, trigger, status)
                 VALUES ($1, $2, $3, 'manual', 'queued')
                 RETURNING id`,
                [organisationId, dto.warehouseId, userId],
            );
            const runId = inserted[0].id;

            // Same transaction as the INSERT → atomic with the run row.
            await em.query(`SELECT pgmq.send($1, $2::jsonb)`, [
                QUEUE_NAME,
                JSON.stringify({
                    kind: 'on_demand',
                    runId,
                    organisationId,
                    warehouseId: dto.warehouseId,
                    setOffOverrides: overrides,
                }),
            ]);

            this.logger.log(`Enqueued on-demand optimisation ${runId} for org ${organisationId}.`);
            return { runId, status: 'queued' as const };
        });
    }

    /**
     * The org's most recent run plus the next time a run is allowed. Drives the
     * dashboard's status polling and the disabled-button countdown.
     */
    async getLatest(organisationId: string): Promise<{
        id: string;
        status: string;
        requestedAt: string;
        optimisationId: string | null;
        error: string | null;
        nextAllowedAt: string | null;
    } | null> {
        const run = await this.optimisationRunRepo.findOne({
            where: { organisationId },
            order: { requestedAt: 'DESC' },
        });
        if (!run) return null;

        // Only runs that "count" gate the next allowed time (failed/skipped don't).
        const counts = run.status !== 'failed' && run.status !== 'skipped';
        const nextAllowedAt = counts
            ? new Date(run.requestedAt.getTime() + RATE_LIMIT_MINUTES * 60_000).toISOString()
            : null;

        return {
            id: run.id,
            status: run.status,
            requestedAt: run.requestedAt.toISOString(),
            optimisationId: run.optimisationId,
            error: run.error,
            nextAllowedAt,
        };
    }
}
