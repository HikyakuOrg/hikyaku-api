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
import {
    DatabaseService,
    SHIFT_WINDOW_SECONDS,
    TIME_PER_STOP,
} from '../database/database.service';
import { VroomService } from '../vroom/vroom.service';
import { orsProfileToValhallaCosting } from '../vroom/profile-map';
import type {
    VroomJob,
    VroomRequest,
    VroomVehicle,
} from '../vroom/vroom.types';
import type { RunOptimisationDto } from './dto/run-optimisation.dto';
import type { AdhocOptimisationDto } from './dto/adhoc-optimisation.dto';

/** Minimum gap between on-demand runs for a single organisation. */
const RATE_LIMIT_MINUTES = 5;

@Injectable()
export class OptimisationService {
    private readonly logger = new Logger(OptimisationService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(OptimisationRun)
        private readonly optimisationRunRepo: Repository<OptimisationRun>,
        private readonly vroom: VroomService,
        private readonly db: DatabaseService,
    ) { }

    /**
     * Synchronous ad-hoc optimisation for the mobile app. Derives coordinates
     * from the warehouse (starting_location_id) and the explicit customer list,
     * builds a single-vehicle VROOM request, solves it, persists the result into
     * the vrp_* tables, and returns the vrp_optimization id.
     *
     * All lookups are org-scoped; unknown/other-org warehouse or customers yield
     * a 400 so cross-org rows are never leaked.
     */
    async runAdhoc(
        organisationId: string,
        dto: AdhocOptimisationDto,
    ): Promise<{ id: string; routeId: string | null; unassignedCustomerIds: string[] }> {
        // 1. Warehouse (org-scoped) → start/end coordinates.
        const whRows: { lon: number | null; lat: number | null }[] =
            await this.dataSource.query(
                `SELECT ST_X(warehouse_location::geometry) AS lon,
                        ST_Y(warehouse_location::geometry) AS lat
                 FROM warehouse
                 WHERE id = $1 AND organisation_id = $2`,
                [dto.startingLocationId, organisationId],
            );
        const wh = whRows[0];
        if (!wh || wh.lon == null || wh.lat == null) {
            throw new BadRequestException('Warehouse not found for this organisation.');
        }
        const warehouseCoords: [number, number] = [wh.lon, wh.lat];

        // 2. Vehicle profile (vehicle_type is a global lookup, not org-scoped).
        const vtRows: { ors_vehicle_type: string }[] = await this.dataSource.query(
            `SELECT ors_vehicle_type FROM vehicle_type WHERE id = $1`,
            [dto.vehicleType],
        );
        if (vtRows.length === 0) {
            throw new BadRequestException('Vehicle type not found.');
        }
        const profile = orsProfileToValhallaCosting(vtRows[0].ors_vehicle_type);

        // 3. Customers (org-scoped). Dedupe, preserve order, require all found.
        const requestedIds = Array.from(new Set(dto.customers));
        const custRows: { id: string; lon: number | null; lat: number | null }[] =
            await this.dataSource.query(
                `SELECT id,
                        ST_X(customer_location::geometry) AS lon,
                        ST_Y(customer_location::geometry) AS lat
                 FROM customer
                 WHERE id = ANY($1::uuid[]) AND organisation_id = $2`,
                [requestedIds, organisationId],
            );
        const coordsById = new Map(custRows.map((c) => [c.id, c]));
        const missing = requestedIds.filter((id) => {
            const c = coordsById.get(id);
            return !c || c.lon == null || c.lat == null;
        });
        if (missing.length > 0) {
            throw new BadRequestException(
                `Unknown or unlocatable customer id(s): ${missing.join(', ')}`,
            );
        }

        // 4. Build the single-vehicle VROOM request. No amounts/capacity → the
        //    only constraint is the vehicle time_window, so every customer is
        //    eligible; VROOM returns the optimal visiting order.
        const jobs: VroomJob[] = [];
        const jobCustomerMap: Record<number, string> = {};
        requestedIds.forEach((id, i) => {
            const c = coordsById.get(id)!;
            const jobId = i + 1;
            jobs.push({ id: jobId, service: TIME_PER_STOP, location: [c.lon!, c.lat!] });
            jobCustomerMap[jobId] = id;
        });

        const startEpoch = Math.floor(new Date(dto.startDateTime).getTime() / 1000);
        const vehicle: VroomVehicle = {
            id: 1,
            profile,
            start: warehouseCoords,
            end: warehouseCoords,
            time_window: [startEpoch, startEpoch + SHIFT_WINDOW_SECONDS],
        };

        const vroomRequest: VroomRequest = { jobs, vehicles: [vehicle] };

        // 5. Solve (VROOM routes via Valhalla).
        const response = await this.vroom.solve(vroomRequest);

        // 6. Persist. Store a richer request so the customer↔job mapping is
        //    recoverable from vrp_optimization.request (steps carry no customer id).
        const requestForDb = {
            ...vroomRequest,
            meta: {
                customerByJob: jobCustomerMap,
                startDateTime: dto.startDateTime,
                startingLocationId: dto.startingLocationId,
                vehicleType: dto.vehicleType,
            },
        };

        const runner = await this.db.beginTransaction();
        try {
            const result = await this.db.insertAdhocRoutes(
                runner,
                requestForDb,
                response,
                jobCustomerMap,
                { organisationId, scheduledStart: new Date(dto.startDateTime) },
            );
            await runner.commitTransaction();
            this.logger.log(
                `Ad-hoc optimisation committed (${result.optimizationId}) for org ${organisationId}.`,
            );
            return {
                id: result.optimizationId,
                routeId: result.routeId,
                unassignedCustomerIds: result.unassignedCustomerIds,
            };
        } catch (err) {
            await runner.rollbackTransaction();
            throw err;
        } finally {
            await runner.release();
        }
    }

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
