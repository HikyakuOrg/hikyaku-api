import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DatabaseService } from '../database/database.service';
import { SchedulerRun } from 'src/entities/scheduler-run.entity';
import type { BuildResult } from '../database/database.types';
import { OrsService } from '../ors/ors.service';
import type { DirectionsRequest, OptimizationResponse, OptimizationRoute } from '../ors/ors.types';
import { QueueService } from './queue.service';

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
        private readonly databaseService: DatabaseService,
        private readonly orsService: OrsService,
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
     * database and ORS. Messages that fail are retried automatically when the
     * visibility timeout expires; after MAX_RETRIES the message is deleted and
     * the run is marked failed.
     */
    @Cron('*/30 * * * * *')
    async handleQueue(): Promise<void> {
        const msg = await this.queueService.readOne(QUEUE_VT_SECONDS);
        if (!msg) return;

        const { warehouseId, runDate } = msg.message as { warehouseId: string; runDate: string };
        this.logger.log(`[consumer] Processing optimization for warehouse ${warehouseId} (run_date: ${runDate}).`);

        try {
            await this.runOptimization(warehouseId);
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

    private async runOptimization(warehouseId: string): Promise<void> {
        const runner = await this.databaseService.beginTransaction();
        try {
            const { request, vehicleMap, jobMap, driverMap } =
                await this.databaseService.buildOptimizationRequest(runner);

            if (request.jobs.length === 0) {
                this.logger.log(`Warehouse ${warehouseId}: no eligible packages, skipping ORS call.`);
                await runner.rollbackTransaction();
                return;
            }

            const response = (await this.orsService.proxyPost(
                '/optimization',
                request,
                process.env.ORS_API_KEY ? `Bearer ${process.env.ORS_API_KEY}` : undefined,
            )) as OptimizationResponse;


            await this.databaseService.insertOptimisedRoutes(
                runner, request, response, vehicleMap, jobMap, driverMap,
            );

            await runner.commitTransaction();
            this.logger.log(`Warehouse ${warehouseId}: optimization committed successfully.`);
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

    private async requestRouteGeoJsons(
        request: BuildResult['request'],
        response: OptimizationResponse,
        warehouseId: string,
    ): Promise<DirectionsRequest | null> {
        const authHeader = process.env.ORS_API_KEY ? `Bearer ${process.env.ORS_API_KEY}` : undefined;
        let primaryRouteRequest: DirectionsRequest | null = null;

        const directionRequests = (response.routes ?? [])
            .map((route) => {
                const profile = request.vehicles.find((vehicle) => vehicle.id === route.vehicle)?.profile;
                if (!profile) {
                    this.logger.warn(
                        `Warehouse ${warehouseId}: skipping GeoJSON directions for vehicle ${route.vehicle} because no ORS profile was found.`,
                    );
                    return null;
                }

                const body = this.buildDirectionsGeoJsonRequest(route);
                if (!body) {
                    this.logger.debug(
                        `Warehouse ${warehouseId}: skipping GeoJSON directions for vehicle ${route.vehicle} because fewer than two route coordinates were available.`,
                    );
                    return null;
                }

                primaryRouteRequest ??= body;

                return this.orsService.proxyPost(
                    `/v2/directions/${profile}/geojson`,
                    body,
                    authHeader,
                );
            })
            .filter((promise): promise is Promise<unknown> => promise !== null);

        if (directionRequests.length === 0) {
            return null;
        }

        const results = await Promise.allSettled(directionRequests);
        const failures = results.filter((result) => result.status === 'rejected');

        if (failures.length > 0) {
            this.logger.warn(
                `Warehouse ${warehouseId}: ${failures.length} GeoJSON directions request(s) failed after optimization completed.`,
            );

            failures.forEach((failure) => {
                this.logger.warn(String(failure.reason));
            });
            return primaryRouteRequest;
        }

        this.logger.debug(
            `Warehouse ${warehouseId}: fetched ${results.length} GeoJSON route(s) after optimization.`,
        );

        return primaryRouteRequest;
    }

    private buildDirectionsGeoJsonRequest(route: OptimizationRoute): DirectionsRequest | null {
        const coordinates = route.steps
            .map((step) => step.location)
            .filter((location): location is number[] => Array.isArray(location) && location.length >= 2)
            .reduce<number[][]>((accumulator, location) => {
                const [lon, lat] = location;
                const previous = accumulator[accumulator.length - 1];

                if (!previous || previous[0] !== lon || previous[1] !== lat) {
                    accumulator.push([lon, lat]);
                }

                return accumulator;
            }, []);

        if (coordinates.length < 2) {
            return null;
        }

        return {
            coordinates,
            instructions: false,
        };
    }
}
