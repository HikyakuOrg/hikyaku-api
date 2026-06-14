import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DatabaseService } from '../database/database.service';
import { SchedulerRun } from 'src/entities/scheduler-run.entity';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { VroomService } from '../vroom/vroom.service';
import { QueueService } from './queue.service';
import type { SetOffOverride } from '../database/database.types';

/** Target local hour at which nightly optimization runs. */
const OPTIMIZATION_HOUR = 2;

/** How often (ms) the in-memory warehouse→timezone cache is refreshed. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Visibility timeout (seconds) held on a queue message while optimization runs. */
const QUEUE_VT_SECONDS = 1800; // 30 min

/** Maximum consumer attempts before a message is permanently discarded. */
const MAX_RETRIES = 3;

interface WarehouseTimezoneRow {
    id: string;
    organisation_id: string;
    tzid: string | null;
}

@Injectable()
export class TasksService implements OnApplicationBootstrap {
    private readonly logger = new Logger(TasksService.name);

    /** In-memory cache: warehouse uuid → { tzid, organisationId }. Avoids spatial JOIN every tick. */
    private warehouseTzCache: Map<string, { tzid: string; organisationId: string }> = new Map();
    private cacheBuiltAt: number = 0;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(SchedulerRun) private readonly schedulerRunRepo: Repository<SchedulerRun>,
        @InjectRepository(OptimisationRun) private readonly optimisationRunRepo: Repository<OptimisationRun>,
        private readonly databaseService: DatabaseService,
        private readonly vroomService: VroomService,
        private readonly queueService: QueueService,
    ) { }

    /**
     * Catch-up guard: on server restart, if the nightly job was missed (e.g.
     * the process was down at 2am) and it's now past 2am warehouse-local time,
     * run it immediately — unless the scheduler_runs record already exists.
     */
    async onApplicationBootstrap(): Promise<void> {
        await this.queueService.ensureQueue();
        await this.refreshWarehouseCache();
        await this.checkAndRunOptimizations('boot');
    }

    /**
     * Polls every 5 minutes. The warehouse→timezone mapping is served from an
     * in-memory cache (refreshed hourly) so no DB query is issued on most ticks.
     */
    @Cron(CronExpression.EVERY_5_MINUTES)
    async handleCron(): Promise<void> {
        if (Date.now() - this.cacheBuiltAt > CACHE_TTL_MS) {
            await this.refreshWarehouseCache();
        }
        await this.checkAndRunOptimizations('cron');
    }

    /**
     * Consumer: polls the pgmq queue every 30 seconds and processes one message
     * at a time. Concurrency of 1 eliminates thundering-herd pressure on the
     * database and VROOM. Messages that fail are retried automatically when the
     * visibility timeout expires; after MAX_RETRIES the message is deleted and
     * the run is marked failed.
     */
    @Cron('*/30 * * * * *')
    async handleQueue(): Promise<void> {
        const msg = await this.queueService.readOne(QUEUE_VT_SECONDS);
        if (!msg) return;

        const body = msg.message as Record<string, unknown>;

        // On-demand runs carry a `kind` discriminator; nightly runs don't.
        if (body.kind === 'on_demand') {
            await this.handleOnDemand(msg.msg_id, body);
            return;
        }

        const { warehouseId, runDate } = body as { warehouseId: string; runDate: string };
        this.logger.log(`[consumer] Processing optimization for warehouse ${warehouseId} (run_date: ${runDate}).`);

        try {
            await this.runOptimization({ warehouseId });
            await this.queueService.archive(msg.msg_id);
            await this.schedulerRunRepo.update(
                { warehouseId, runDate },
                { status: 'completed' },
            );
            this.logger.log(`[consumer] Warehouse ${warehouseId}: optimization completed for ${runDate}.`);
        } catch (err: unknown) {
            const result = await this.schedulerRunRepo
                .createQueryBuilder()
                .update()
                .set({ retryCount: () => 'retry_count + 1' })
                .where('warehouse_id = :wh AND run_date = :rd', { wh: warehouseId, rd: runDate })
                .returning('retry_count')
                .execute();
            const retryCount: number = result.raw[0]?.retry_count ?? MAX_RETRIES;

            if (retryCount >= MAX_RETRIES) {
                this.logger.error(
                    `[consumer] Warehouse ${warehouseId}: optimization permanently failed after ${MAX_RETRIES} attempts for ${runDate}. Error: ${String(err)}`,
                );
                await this.queueService.deleteMsg(msg.msg_id);
                await this.schedulerRunRepo.update(
                    { warehouseId, runDate },
                    { status: 'failed' },
                );
            } else {
                this.logger.warn(
                    `[consumer] Warehouse ${warehouseId}: optimization failed (attempt ${retryCount}/${MAX_RETRIES}) for ${runDate}. Retrying after VT expires. Error: ${String(err)}`,
                );
            }
        }
    }

    /**
     * Fetches the warehouse→tzid mapping once via the PostGIS spatial join and
     * stores it in memory. Called on boot and when the TTL expires.
     */
    private async refreshWarehouseCache(): Promise<void> {
        const rows: WarehouseTimezoneRow[] = await this.dataSource.query(`
            SELECT w.id, w.organisation_id, tz.tzid
            FROM   warehouse w
            LEFT   JOIN tzdata.timezone tz
                   ON ST_Within(ST_SetSRID(w.warehouse_location::geometry, 4326), tz.geom)
        `);
        this.warehouseTzCache = new Map(
            rows.map(r => [r.id, { tzid: r.tzid ?? 'UTC', organisationId: r.organisation_id }]),
        );
        this.cacheBuiltAt = Date.now();
        this.logger.debug(`Warehouse timezone cache refreshed (${rows.length} warehouses).`);
    }

    /**
     * Core logic: iterates the in-memory cache, checks local time per warehouse,
     * and claims a scheduler_runs slot atomically before running optimization.
     *
     * For the cron trigger: only act if the local hour is exactly 2.
     * For the boot trigger: act if the local hour is >= 2 (catch-up).
     *
     * The INSERT ... ON CONFLICT DO NOTHING into scheduler_runs is the atomic
     * guard — only the first caller (whether cron or restart) will get a
     * RETURNING row. All subsequent calls are no-ops for that warehouse+date.
     */
    private async checkAndRunOptimizations(trigger: 'cron' | 'boot'): Promise<void> {
        const warehouses = [...this.warehouseTzCache.entries()].map(([id, v]) => ({ id, ...v }));

        for (const warehouse of warehouses) {
            const tzid = warehouse.tzid;
            const now = new Date();

            const localHour = this.getLocalHour(now, tzid);
            const localDate = this.getLocalDate(now, tzid); // YYYY-MM-DD

            const isInWindow =
                trigger === 'boot'
                    ? localHour >= OPTIMIZATION_HOUR   // missed while down
                    : localHour === OPTIMIZATION_HOUR; // normal cron tick

            if (!isInWindow) continue;

            // Atomic claim — unique constraint on (warehouse_id, run_date) means
            // only one winner per warehouse per local calendar day.
            const claimResult = await this.dataSource
                .createQueryBuilder()
                .insert()
                .into(SchedulerRun)
                .values({ organisationId: warehouse.organisationId, warehouseId: warehouse.id, runDate: localDate })
                .orIgnore()
                .returning('id')
                .execute();

            if (claimResult.identifiers.length === 0) {
                this.logger.debug(
                    `[${trigger}] Warehouse ${warehouse.id}: already ran for ${localDate}, skipping.`,
                );
                continue;
            }

            await this.queueService.enqueue(warehouse.id, localDate);
            this.logger.log(
                `[${trigger}] Warehouse ${warehouse.id}: enqueued optimization for ${localDate} (tz: ${tzid})`,
            );
        }
    }

    /**
     * Processes one on-demand run: marks it running, optimises with per-vehicle
     * time windows, and records the terminal status the dashboard polls for.
     * On-demand runs are not auto-retried (a failure is surfaced to the
     * dispatcher, who can trigger again); the message is removed either way.
     */
    private async handleOnDemand(msgId: bigint, body: Record<string, unknown>): Promise<void> {
        const runId = body.runId as string;
        const organisationId = body.organisationId as string;
        const warehouseId = body.warehouseId as string;
        const setOffOverrides = (body.setOffOverrides as SetOffOverride[] | undefined) ?? [];

        this.logger.log(`[consumer] Processing on-demand optimisation ${runId} (warehouse ${warehouseId}).`);
        await this.optimisationRunRepo.update({ id: runId }, { status: 'running' });

        try {
            const optimizationId = await this.runOptimization({
                warehouseId,
                organisationId,
                useTimeWindows: true,
                setOffOverrides,
            });
            await this.queueService.archive(msgId);
            await this.optimisationRunRepo.update(
                { id: runId },
                optimizationId
                    ? { status: 'completed', optimisationId: optimizationId }
                    : { status: 'skipped' },
            );
            this.logger.log(
                `[consumer] On-demand optimisation ${runId} ${optimizationId ? 'completed' : 'skipped (no eligible packages)'}.`,
            );
        } catch (err: unknown) {
            this.logger.error(`[consumer] On-demand optimisation ${runId} failed: ${String(err)}`);
            await this.queueService.deleteMsg(msgId);
            await this.optimisationRunRepo.update(
                { id: runId },
                { status: 'failed', error: String(err) },
            );
        }
    }

    private async runOptimization(opts: {
        warehouseId: string;
        organisationId?: string;
        useTimeWindows?: boolean;
        setOffOverrides?: SetOffOverride[];
    }): Promise<string | null> {
        const runner = await this.databaseService.beginTransaction();
        try {
            const build = await this.databaseService.buildOptimizationRequest(runner, opts);

            if (build.request.jobs.length === 0) {
                this.logger.log(`Warehouse ${opts.warehouseId}: no eligible packages, skipping VROOM call.`);
                await runner.rollbackTransaction();
                return null;
            }

            const response = await this.vroomService.solve(build.request);

            const optimizationId = await this.databaseService.insertOptimisedRoutes(
                runner,
                build.request,
                response,
                build.vehicleMap,
                build.jobMap,
                build.driverMap,
                { organisationId: build.organisationId, timeWindowed: build.timeWindowed },
            );

            await runner.commitTransaction();
            this.logger.log(`Warehouse ${opts.warehouseId}: optimization committed (${optimizationId}).`);
            return optimizationId;
        } catch (err) {
            await runner.rollbackTransaction();
            throw err;
        } finally {
            await runner.release();
        }
    }

    /**
     * Returns the local hour (0–23) in the given IANA timezone.
     * Uses hourCycle h23 to avoid the '24' edge-case at midnight.
     */
    private getLocalHour(date: Date, tzid: string): number {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tzid,
            hour: 'numeric',
            hourCycle: 'h23',
        }).formatToParts(date);
        return Number(parts.find(p => p.type === 'hour')?.value ?? '0');
    }

    /**
     * Returns the local calendar date as a YYYY-MM-DD string suitable for
     * Postgres ::date casts.
     */
    private getLocalDate(date: Date, tzid: string): string {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tzid }).format(date);
    }
}
