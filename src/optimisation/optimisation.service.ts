import {
    BadRequestException,
    ConflictException,
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
     * from the warehouse (starting_location_id) and the recipient of each
     * requested package, builds a single-vehicle VROOM request, solves it,
     * persists the result into the vrp_* tables, and returns the
     * vrp_optimization id.
     *
     * The packages already exist — the mobile wizard creates or picks them
     * before calling this — so this only loads, validates and claims them.
     *
     * All lookups are org-scoped; an unknown/other-org warehouse or package
     * yields a 400 so cross-org rows are never leaked. A package already
     * claimed by another optimisation yields a 409.
     */
    async runAdhoc(
        organisationId: string,
        dto: AdhocOptimisationDto,
    ): Promise<{ id: string; routeId: string | null; unassignedPackageIds: string[] }> {
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

        // 2. Driver and vehicle (both org-scoped). The vehicle also resolves the
        //    routing profile via vehicles.vehicle_type — no separate vehicleType
        //    input needed. package_assignment has an enforce_driver_vehicle_warehouse
        //    trigger requiring driver and vehicle to share a warehouse, so check
        //    that here too for a clean 400 instead of a raw DB error.
        const driverRows: { warehouse_id: string | null }[] = await this.dataSource.query(
            `SELECT warehouse_id FROM drivers WHERE id = $1 AND organisation_id = $2`,
            [dto.driverId, organisationId],
        );
        if (driverRows.length === 0) {
            throw new BadRequestException('Driver not found for this organisation.');
        }

        const vehicleRows: { warehouse_id: string | null; ors_vehicle_type: string }[] =
            await this.dataSource.query(
                `SELECT v.warehouse_id, vt.ors_vehicle_type
                 FROM vehicles v
                 JOIN vehicle_type vt ON vt.id = v.vehicle_type
                 WHERE v.id = $1 AND v.organisation_id = $2`,
                [dto.vehicleId, organisationId],
            );
        if (vehicleRows.length === 0) {
            throw new BadRequestException('Vehicle not found for this organisation.');
        }

        if (driverRows[0].warehouse_id !== vehicleRows[0].warehouse_id) {
            throw new BadRequestException('Driver and vehicle must belong to the same warehouse.');
        }

        const profile = orsProfileToValhallaCosting(vehicleRows[0].ors_vehicle_type);

        // 3. Packages. Dedupe, preserve order, validate the whole batch up front
        //    so the caller gets one clear error rather than a partial failure.
        //
        //    packages has no organisation_id column, so the org scope is derived
        //    from the owning warehouse — combined with the warehouse_id check
        //    below, a package can only pass if it sits at a warehouse this org
        //    owns. Rows outside the org simply do not come back, and are
        //    reported as unknown rather than "wrong warehouse", so this never
        //    discloses the existence of another org's package.
        const requestedIds = Array.from(new Set(dto.packages));
        const pkgRows: {
            id: string;
            warehouse_id: string | null;
            optimisation_id: string | null;
            lon: number | null;
            lat: number | null;
        }[] = await this.dataSource.query(
            `SELECT p.id,
                    p.warehouse_id,
                    p.optimisation_id,
                    ST_X(c.customer_location::geometry) AS lon,
                    ST_Y(c.customer_location::geometry) AS lat
             FROM packages p
             JOIN warehouse w ON w.id = p.warehouse_id
             LEFT JOIN customer c ON c.id = p.to_customer
             WHERE p.id = ANY($1::uuid[]) AND w.organisation_id = $2`,
            [requestedIds, organisationId],
        );
        const packagesById = new Map(pkgRows.map((p) => [p.id, p]));

        const unknown: string[] = [];
        const wrongWarehouse: string[] = [];
        const unlocatable: string[] = [];
        const alreadyClaimed: string[] = [];
        for (const id of requestedIds) {
            const pkg = packagesById.get(id);
            if (!pkg) {
                unknown.push(id);
            } else if (pkg.warehouse_id !== dto.startingLocationId) {
                // A shift is one vehicle out of one depot; a package sitting at a
                // different warehouse cannot be on this route.
                wrongWarehouse.push(id);
            } else if (pkg.lon == null || pkg.lat == null) {
                unlocatable.push(id);
            } else if (pkg.optimisation_id !== null) {
                alreadyClaimed.push(id);
            }
        }

        // 400 (bad input) takes precedence over 409 (live contention).
        const problems: string[] = [];
        if (unknown.length > 0) {
            problems.push(`unknown package id(s): ${unknown.join(', ')}`);
        }
        if (wrongWarehouse.length > 0) {
            problems.push(
                `package(s) not at warehouse ${dto.startingLocationId}: ${wrongWarehouse.join(', ')}`,
            );
        }
        if (unlocatable.length > 0) {
            problems.push(
                `package(s) whose recipient has no location: ${unlocatable.join(', ')}`,
            );
        }
        if (problems.length > 0) {
            throw new BadRequestException(problems.join('; '));
        }
        if (alreadyClaimed.length > 0) {
            throw new ConflictException(
                `Package(s) already assigned to another optimisation: ${alreadyClaimed.join(', ')}`,
            );
        }

        // 4. Build the single-vehicle VROOM request, one job per package at its
        //    recipient's location. No amounts/capacity → the only constraint is
        //    the vehicle time_window, so every package is eligible; VROOM returns
        //    the optimal visiting order.
        const jobs: VroomJob[] = [];
        const jobPackageMap: Record<number, string> = {};
        requestedIds.forEach((id, i) => {
            const pkg = packagesById.get(id)!;
            const jobId = i + 1;
            jobs.push({ id: jobId, service: TIME_PER_STOP, location: [pkg.lon!, pkg.lat!] });
            jobPackageMap[jobId] = id;
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

        // 6. Persist. Store a richer request so the package↔job mapping is
        //    recoverable from vrp_optimization.request (ad-hoc steps carry no
        //    package_id — see insertAdhocRoutes).
        const requestForDb = {
            ...vroomRequest,
            meta: {
                packageByJob: jobPackageMap,
                startDateTime: dto.startDateTime,
                startingLocationId: dto.startingLocationId,
                driverId: dto.driverId,
                vehicleId: dto.vehicleId,
            },
        };

        const runner = await this.db.beginTransaction();
        try {
            const result = await this.db.insertAdhocRoutes(
                runner,
                requestForDb,
                response,
                jobPackageMap,
                {
                    organisationId,
                    scheduledStart: new Date(dto.startDateTime),
                    driverId: dto.driverId,
                    vehicleId: dto.vehicleId,
                },
            );
            await runner.commitTransaction();
            this.logger.log(
                `Ad-hoc optimisation committed (${result.optimizationId}) for org ${organisationId}.`,
            );
            return {
                id: result.optimizationId,
                routeId: result.routeId,
                unassignedPackageIds: result.unassignedPackageIds,
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
