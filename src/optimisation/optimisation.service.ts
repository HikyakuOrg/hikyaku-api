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
import { QUEUE_NAME, REPLAN_CHANNEL } from '../dispatch/queue.service';
import { AssignmentService } from '../dispatch/assignment.service';
import { localShiftDate } from '../dispatch/warehouse-clock';
import { ShiftsService } from '../shifts/shifts.service';
import type { RunOptimisationDto } from './dto/run-optimisation.dto';
import type { AdhocOptimisationDto } from './dto/adhoc-optimisation.dto';

/**
 * Minimum gap between on-demand runs for a single organisation.
 *
 * One minute, down from five. The limit existed because a run created shifts,
 * and every shift insert bills against the organisation's allowance. A run is
 * now a replan of the shifts that already exist -- it inserts nothing and bills
 * nothing -- so all that is left to protect is the solver, and a minute of
 * debounce does that.
 */
const RATE_LIMIT_MINUTES = 1;

@Injectable()
export class OptimisationService {
    private readonly logger = new Logger(OptimisationService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(OptimisationRun)
        private readonly optimisationRunRepo: Repository<OptimisationRun>,
        private readonly shifts: ShiftsService,
        private readonly assignment: AssignmentService,
    ) {}

    /**
     * The mobile create-shift wizard: open a shift and put these packages on it.
     *
     * This used to be a second, parallel implementation of route persistence --
     * its own VROOM call, its own vrp_optimization insert, its own step writes.
     * It is now the validation in front of the two things that already do that
     * job: ShiftsService.create opens the shift (the one billed insert), and
     * AssignmentService.assignToShift orders the stops and writes the plan.
     *
     * The validation is kept verbatim because it is what produces the error
     * semantics the mobile app depends on: all lookups are org-scoped, an
     * unknown or other-org warehouse or package yields a 400 so cross-org rows
     * are never disclosed, and a package already claimed by another optimisation
     * yields a 409.
     *
     * One behaviour change: opening the shift now goes through the "one open
     * shift per driver per day" rule, so a second wizard run for the same driver
     * on the same day is a 409 rather than a second billed shift.
     */
    async runAdhoc(
        organisationId: string,
        dto: AdhocOptimisationDto,
    ): Promise<{
        id: string;
        routeId: string | null;
        unassignedPackageIds: string[];
    }> {
        // 1. Warehouse (org-scoped). Its timezone decides which service day the
        //    shift belongs to -- a start time of 22:00 UTC is tomorrow morning in
        //    Melbourne, and the shift has to be filed under the day the driver
        //    thinks they are working.
        const whRows: {
            lon: number | null;
            lat: number | null;
            timezone: string | null;
        }[] = await this.dataSource.query(
            `SELECT ST_X(warehouse_location::geometry) AS lon,
                    ST_Y(warehouse_location::geometry) AS lat,
                    timezone
             FROM warehouse
             WHERE id = $1 AND organisation_id = $2`,
            [dto.startingLocationId, organisationId],
        );
        const wh = whRows[0];
        if (!wh || wh.lon == null || wh.lat == null) {
            throw new BadRequestException(
                'Warehouse not found for this organisation.',
            );
        }

        // 2. Driver and vehicle (both org-scoped). The vehicle also resolves the
        //    routing profile via vehicles.vehicle_type — no separate vehicleType
        //    input needed. package_assignment has an enforce_driver_vehicle_warehouse
        //    trigger requiring driver and vehicle to share a warehouse, so check
        //    that here too for a clean 400 instead of a raw DB error.
        const driverRows: { warehouse_id: string | null }[] =
            await this.dataSource.query(
                `SELECT warehouse_id FROM drivers WHERE id = $1 AND organisation_id = $2`,
                [dto.driverId, organisationId],
            );
        if (driverRows.length === 0) {
            throw new BadRequestException(
                'Driver not found for this organisation.',
            );
        }

        const vehicleRows: { warehouse_id: string | null }[] =
            await this.dataSource.query(
                `SELECT v.warehouse_id
                 FROM vehicles v
                 WHERE v.id = $1 AND v.organisation_id = $2`,
                [dto.vehicleId, organisationId],
            );
        if (vehicleRows.length === 0) {
            throw new BadRequestException(
                'Vehicle not found for this organisation.',
            );
        }

        if (driverRows[0].warehouse_id !== vehicleRows[0].warehouse_id) {
            throw new BadRequestException(
                'Driver and vehicle must belong to the same warehouse.',
            );
        }

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

        // 4. Open the shift. THE ONE BILLED INSERT on this path, exactly as
        //    before -- but through the endpoint that owns shift creation, so the
        //    driver/vehicle/warehouse/date land in columns instead of a
        //    request._meta blob, and the one-open-shift-per-day rule applies.
        const shift = await this.shifts.create(organisationId, {
            warehouseId: dto.startingLocationId,
            driverId: dto.driverId,
            vehicleId: dto.vehicleId,
            shiftDate: localShiftDate(new Date(dto.startDateTime), wh.timezone),
            scheduledStart: dto.startDateTime,
        });

        // 5. Put the packages on it. Cheapest-insertion ordering rather than a
        //    VROOM call: the wizard is interactive and the replan worker
        //    re-solves the shift properly within seconds of this returning.
        const { verdicts } = await this.assignment.assignToShift(
            organisationId,
            shift.id,
            requestedIds,
        );

        const unassignedPackageIds = verdicts
            .filter((v) => !v.added)
            .map((v) => v.packageId);

        this.logger.log(
            `Ad-hoc shift ${shift.id} opened for org ${organisationId} with ` +
                `${verdicts.length - unassignedPackageIds.length} package(s).`,
        );

        return {
            id: shift.id,
            routeId: shift.routeId,
            unassignedPackageIds,
        };
    }

    /**
     * "Re-optimise": replan every open shift at this warehouse.
     *
     * It used to mean "solve the warehouse from scratch", which created shifts
     * and therefore cost money. It now enqueues one replan per shift that
     * already exists, so it inserts nothing into vrp_optimization and bills
     * nothing -- which is what let the rate limit drop from five minutes to one.
     *
     * The advisory lock, the run row and the queue send still commit together,
     * so a run can never exist without its messages or the reverse.
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
            throw new BadRequestException(
                'Warehouse not found for this organisation.',
            );
        }

        const overrides = dto.setOffOverrides ?? [];

        return this.dataSource.transaction(async (em) => {
            // Serialise per-org so two simultaneous requests can't both pass the
            // rate-limit check (advisory lock auto-releases at txn end).
            await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
                organisationId,
            ]);

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
                    new Date(recent[0].requested_at).getTime() +
                        RATE_LIMIT_MINUTES * 60_000,
                ).toISOString();
                throw new HttpException(
                    {
                        message: 'Optimisation was run recently. Please wait.',
                        nextAllowedAt,
                    },
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

            const shifts: { id: string }[] = await em.query(
                `SELECT id
                   FROM vrp_optimization
                  WHERE warehouse_id = $1
                    AND organisation_id = $2
                    AND status = 'planned'
                  ORDER BY created_at`,
                [dto.warehouseId, organisationId],
            );

            if (shifts.length === 0) {
                // Nothing to replan. Terminal immediately rather than leaving the
                // dashboard polling a run no consumer will ever pick up.
                await em.query(
                    `UPDATE optimisation_run SET status = 'skipped', error = $2 WHERE id = $1`,
                    [runId, 'No open shifts at this warehouse to re-optimise.'],
                );
                this.logger.log(
                    `Run ${runId}: warehouse ${dto.warehouseId} has no open shifts.`,
                );
                return { runId, status: 'queued' as const };
            }

            // Same transaction as the run row, so neither can exist alone. The
            // NOTIFY is the doorbell and pgmq is the work list -- a notification
            // lost to a reconnecting listener costs latency, not the replan.
            for (const shift of shifts) {
                await em.query(`SELECT pgmq.send($1, $2::jsonb)`, [
                    QUEUE_NAME,
                    JSON.stringify({
                        kind: 'replan',
                        optimisationId: shift.id,
                        warehouseId: dto.warehouseId,
                        organisationId,
                    }),
                ]);
            }
            await em.query(`SELECT pg_notify($1, $2)`, [
                REPLAN_CHANNEL,
                shifts[0].id,
            ]);

            // The run itself is done: it enqueued what it was asked to. Each
            // shift's own `revision` is what says whether its solve has landed.
            await em.query(
                `UPDATE optimisation_run SET status = 'completed', optimisation_id = $2 WHERE id = $1`,
                [runId, shifts[0].id],
            );

            this.logger.log(
                `Run ${runId}: queued ${shifts.length} replan(s) at warehouse ${dto.warehouseId}.`,
            );
            void overrides;
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
            ? new Date(
                  run.requestedAt.getTime() + RATE_LIMIT_MINUTES * 60_000,
              ).toISOString()
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
