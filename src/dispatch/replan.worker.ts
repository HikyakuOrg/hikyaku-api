import {
    Injectable,
    Logger,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OptimisationRun } from 'src/entities/optimisation-run.entity';
import { DatabaseService } from 'src/database/database.service';
import { VroomService } from 'src/vroom/vroom.service';
import { orsProfileToValhallaCosting } from 'src/vroom/profile-map';
import type { VroomJob, VroomRequest } from 'src/vroom/vroom.types';
import type { SetOffOverride } from 'src/database/database.types';
import { PgNotifyService } from './pg-notify.service';
import {
    QueueService,
    REPLAN_CHANNEL,
    type PgmqMessage,
} from './queue.service';
import { ShiftPlanWriter, type PlanStop } from './shift-plan.writer';
import { AssignmentService } from './assignment.service';
import { SHIFT_WINDOW_SECONDS, TIME_PER_STOP } from './insertion';

/** Coalescing window for replan notifications, in ms. */
const DEBOUNCE_MS = 3_000;

/**
 * How often the pgmq sweep runs, in ms.
 *
 * THIS IS THE ONE TIMER LEFT IN THE CODEBASE, and it is not a scheduler. A
 * NOTIFY fired while the listening connection is re-establishing is delivered to
 * nobody; without a sweep, that shift is never re-optimised until an unrelated
 * package happens to arrive at the same warehouse — a silent failure with no
 * symptom. Sixty seconds of pgmq.read against an empty queue is one cheap
 * indexed query a minute, which is the price of that failure mode not existing.
 */
const SWEEP_MS = 60_000;

/** Visibility timeout held on a message while it is being worked, in seconds. */
const QUEUE_VT_SECONDS = 1800;

/** Messages read per drain pass. */
const BATCH_SIZE = 20;

/** Consumer attempts before a message is discarded as a poison pill. */
const MAX_RETRIES = 3;

interface ShiftRow {
    id: string;
    status: string;
    organisation_id: string | null;
    warehouse_id: string | null;
    driver_id: string | null;
    vehicle_id: string | null;
    revision: number;
    scheduled_start: string | null;
    vehicle_gross_limits: string | number | null;
    ors_vehicle_type: string | null;
    depot_lon: number | null;
    depot_lat: number | null;
}

interface ShiftPackageRow {
    id: string;
    weight_kg: string | number | null;
    scheduled_arrival: string | null;
    lon: number | null;
    lat: number | null;
}

/**
 * Tier 2: re-solve a touched shift properly.
 *
 * Tier 1 answers in milliseconds using haversine estimates with a deliberate
 * safety margin, which means its plans are worse than VROOM's — that is the
 * point of having two tiers. This worker closes the gap a few seconds later with
 * a real solve, and this is where `time_windows` is FINALLY POPULATED, so a
 * deadline stops being a priority hint and becomes a hard constraint.
 *
 * It NEVER INSERTS vrp_optimization. Every insert bills a shift against the
 * organisation's allowance, so a replanning loop that inserted would burn the
 * allowance and eventually hard-fail with 23514. Replanning updates in place,
 * forever, for free.
 *
 * Woken by LISTEN/NOTIFY, made durable by pgmq, and backstopped by one sweep
 * timer. See SWEEP_MS for why that timer is not a cron in disguise.
 */
@Injectable()
export class ReplanWorker implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(ReplanWorker.name);
    private sweepTimer: NodeJS.Timeout | null = null;
    private draining = false;
    private pendingDrain = false;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(OptimisationRun)
        private readonly optimisationRunRepo: Repository<OptimisationRun>,
        private readonly queue: QueueService,
        private readonly notify: PgNotifyService,
        private readonly planWriter: ShiftPlanWriter,
        private readonly assignment: AssignmentService,
        private readonly db: DatabaseService,
        private readonly vroom: VroomService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.queue.ensureQueue().catch((err: unknown) => {
            this.logger.warn(
                `Could not ensure the queue exists: ${String(err)}`,
            );
        });

        this.notify.subscribe({
            channel: REPLAN_CHANNEL,
            debounceMs: DEBOUNCE_MS,
            // The payload is ignored on purpose: pgmq is the work list, the
            // notification is only the doorbell. A drain triggered by one shift's
            // notify picks up every other shift queued in the same window, which
            // is what turns a 500-package import into a handful of solves.
            onWake: () => this.drain(),
        });

        this.sweepTimer = setInterval(() => void this.drain(), SWEEP_MS);
        this.sweepTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
    }

    /**
     * Reads whatever is queued and processes it.
     *
     * Single-flight: a drain already in progress records that another was asked
     * for and runs it once, rather than stacking concurrent solves on top of each
     * other. Cross-replica exclusion is pgmq's visibility timeout plus the
     * per-shift advisory lock, not this flag.
     */
    async drain(): Promise<void> {
        if (this.draining) {
            this.pendingDrain = true;
            return;
        }
        this.draining = true;
        try {
            do {
                this.pendingDrain = false;
                await this.drainOnce();
            } while (this.pendingDrain);
        } finally {
            this.draining = false;
        }
    }

    private async drainOnce(): Promise<void> {
        let messages: PgmqMessage[];
        try {
            messages = await this.queue.readBatch(QUEUE_VT_SECONDS, BATCH_SIZE);
        } catch (err: unknown) {
            this.logger.warn(`Queue read failed: ${String(err)}`);
            return;
        }
        if (messages.length === 0) return;

        // Coalesce: a burst of package creations queues one replan per package,
        // all naming the same shift. Solving that shift once is the entire point.
        const seenShifts = new Set<string>();

        for (const message of messages) {
            const body = message.message;

            if (body.kind === 'replan') {
                const optimisationId = String(body.optimisationId ?? '');
                if (seenShifts.has(optimisationId)) {
                    await this.queue.archive(message.msg_id);
                    continue;
                }
                seenShifts.add(optimisationId);
            }

            await this.handleMessage(message);
        }
    }

    /**
     * Processes one queue message.
     *
     * This worker is now the only consumer of the queue. A leftover nightly
     * payload from before the scheduler was removed carries no `kind` and is
     * archived rather than retried -- there is nothing left that knows how to run
     * a whole-warehouse nightly solve, and cycling it forever would be worse than
     * dropping it.
     */
    private async handleMessage(message: PgmqMessage): Promise<void> {
        const body = message.message;

        try {
            if (body.kind === 'replan') {
                await this.replanShift(String(body.optimisationId ?? ''));
            } else if (body.kind === 'on_demand') {
                await this.handleOnDemand(message.msg_id, body);
                return; // handleOnDemand owns the message's fate.
            } else {
                // Nothing else should reach this worker. Archive rather than
                // retry so an unknown payload cannot cycle forever.
                this.logger.warn(
                    `Ignoring queue message ${message.msg_id} with no recognised kind.`,
                );
            }
            await this.queue.archive(message.msg_id);
        } catch (err: unknown) {
            const attempts = Number(message.read_ct ?? 0);
            if (attempts >= MAX_RETRIES) {
                this.logger.error(
                    `Message ${message.msg_id} permanently failed after ${attempts} attempts: ${String(err)}`,
                );
                await this.queue.deleteMsg(message.msg_id);
            } else {
                this.logger.warn(
                    `Message ${message.msg_id} failed (attempt ${attempts}/${MAX_RETRIES}), retrying after the visibility timeout: ${String(err)}`,
                );
            }
        }
    }

    // ── Tier 2 ───────────────────────────────────────────────────────────────

    /**
     * Re-solves one shift against its current package set and rewrites the plan
     * in place.
     */
    async replanShift(optimisationId: string): Promise<void> {
        if (!optimisationId) return;

        // Session-scoped, so it must be released by hand. try_ rather than a
        // blocking lock: if another replica is already solving this shift there
        // is nothing useful to wait for — its solve will include whatever this
        // one would have.
        const lockKey = `replan:${optimisationId}`;
        const lockRows: { locked: boolean }[] = await this.dataSource.query(
            `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
            [lockKey],
        );
        if (!lockRows[0]?.locked) {
            this.logger.debug(
                `Shift ${optimisationId} is already being replanned.`,
            );
            return;
        }

        try {
            const shift = await this.loadShift(optimisationId);
            if (!shift) return;
            if (shift.status !== 'planned') {
                this.logger.debug(
                    `Shift ${optimisationId} is ${shift.status}; not replanning a van that has rolled.`,
                );
                return;
            }
            if (shift.depot_lon == null || shift.depot_lat == null) return;
            if (!shift.driver_id || !shift.vehicle_id) return;

            const packages = await this.loadShiftPackages(optimisationId);
            const routable = packages.filter(
                (p) => p.lon != null && p.lat != null,
            );
            if (routable.length === 0) return;

            const departureMs = shift.scheduled_start
                ? new Date(shift.scheduled_start).getTime()
                : Date.now();
            const departureEpoch = Math.floor(departureMs / 1000);

            const jobs: VroomJob[] = [];
            const jobPackage: Record<number, string> = {};
            routable.forEach((pkg, i) => {
                const jobId = i + 1;
                jobPackage[jobId] = pkg.id;
                const job: VroomJob = {
                    id: jobId,
                    service: TIME_PER_STOP,
                    location: [Number(pkg.lon), Number(pkg.lat)],
                    amount: [this.weightGrams(pkg.weight_kg)],
                };
                // The whole reason Tier 2 exists. Until now VROOM was told about
                // deadlines only as a priority hint, which it is free to ignore;
                // a time window is a constraint it cannot violate.
                if (pkg.scheduled_arrival) {
                    const deadline = Math.floor(
                        new Date(pkg.scheduled_arrival).getTime() / 1000,
                    );
                    if (deadline > departureEpoch) {
                        job.time_windows = [[departureEpoch, deadline]];
                    }
                }
                jobs.push(job);
            });

            const request: VroomRequest = {
                jobs,
                vehicles: [
                    {
                        id: 1,
                        profile: orsProfileToValhallaCosting(
                            shift.ors_vehicle_type ?? 'driving-car',
                        ),
                        start: [shift.depot_lon, shift.depot_lat],
                        end: [shift.depot_lon, shift.depot_lat],
                        // Grams on both sides. See AssignmentService.capacityGrams.
                        capacity: [
                            this.capacityGrams(shift.vehicle_gross_limits),
                        ],
                        time_window: [
                            departureEpoch,
                            departureEpoch + SHIFT_WINDOW_SECONDS,
                        ],
                    },
                ],
            };

            const response = await this.vroom.solve(request);

            const route = response.routes?.[0];
            const stops: PlanStop[] = [];
            const packageById = new Map(routable.map((p) => [p.id, p]));

            for (const step of route?.steps ?? []) {
                if (step.type !== 'job' || step.id == null) continue;
                const packageId = jobPackage[step.id];
                const pkg = packageId ? packageById.get(packageId) : undefined;
                if (!pkg) continue;
                stops.push({
                    packageId,
                    lon: Number(pkg.lon),
                    lat: Number(pkg.lat),
                    // Arrivals are absolute epoch seconds whenever a vehicle
                    // time_window is present, which it always is here.
                    arrivalMs: (step.arrival ?? departureEpoch) * 1000,
                    weightG: this.weightGrams(pkg.weight_kg),
                });
            }

            const unassigned = (response.unassigned ?? [])
                .map((u) => jobPackage[u.id])
                .filter((id): id is string => Boolean(id));

            const runner = this.dataSource.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            try {
                const { routeId, solutionId } =
                    await this.planWriter.ensureRoute(runner, optimisationId);
                await this.planWriter.snapshotRevision(
                    runner,
                    optimisationId,
                    shift.revision,
                    'replan',
                );
                // Detach first: a package VROOM could not fit must lose its
                // assignment before the new step list is written, or its stale
                // step survives as an orphan.
                if (unassigned.length > 0) {
                    await this.planWriter.detach(runner, unassigned, {
                        incrementEviction: false,
                    });
                }
                await this.planWriter.writePlan(runner, {
                    optimisationId,
                    routeId,
                    solutionId,
                    depot: { lon: shift.depot_lon, lat: shift.depot_lat },
                    departureMs,
                    driverId: shift.driver_id,
                    vehicleId: shift.vehicle_id,
                    stops,
                    reason: 'replan',
                });
                await runner.commitTransaction();
            } catch (err) {
                await runner.rollbackTransaction();
                throw err;
            } finally {
                await runner.release();
            }

            this.logger.log(
                `Replanned shift ${optimisationId}: ${stops.length} stop(s)` +
                    (unassigned.length > 0
                        ? `, ${unassigned.length} unassigned`
                        : '') +
                    '.',
            );

            // Anything VROOM dropped goes back through Tier 1, which will try
            // other shifts at the warehouse and open one if it has to.
            if (unassigned.length > 0 && shift.organisation_id) {
                for (const packageId of unassigned) {
                    await this.assignment.assign(
                        shift.organisation_id,
                        packageId,
                    );
                }
            }
        } finally {
            await this.dataSource
                .query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey])
                .catch(() => undefined);
        }
    }

    /**
     * The dashboard's "re-optimise" button. Unchanged behaviour, moved here with
     * the rest of the consumer — it is not a replan, it is a whole-warehouse
     * solve, and it still bills whatever shifts it creates.
     */
    private async handleOnDemand(
        msgId: bigint,
        body: Record<string, unknown>,
    ): Promise<void> {
        const runId = String(body.runId ?? '');
        const organisationId = String(body.organisationId ?? '');
        const warehouseId = String(body.warehouseId ?? '');
        const setOffOverrides =
            (body.setOffOverrides as SetOffOverride[] | undefined) ?? [];

        this.logger.log(
            `Processing on-demand optimisation ${runId} (warehouse ${warehouseId}).`,
        );
        await this.optimisationRunRepo.update(
            { id: runId },
            { status: 'running' },
        );

        try {
            const result = await this.runWarehouseOptimisation({
                warehouseId,
                organisationId,
                useTimeWindows: true,
                setOffOverrides,
            });
            await this.queue.archive(msgId);
            await this.optimisationRunRepo.update(
                { id: runId },
                result.optimisationId
                    ? {
                          status: 'completed',
                          optimisationId: result.optimisationId,
                      }
                    : { status: 'skipped', error: result.skipReason },
            );
        } catch (err: unknown) {
            this.logger.error(
                `On-demand optimisation ${runId} failed: ${String(err)}`,
            );
            // On-demand runs are not auto-retried: the failure is surfaced to the
            // dispatcher, who can trigger again.
            await this.queue.deleteMsg(msgId);
            await this.optimisationRunRepo.update(
                { id: runId },
                { status: 'failed', error: String(err) },
            );
        }
    }

    private async runWarehouseOptimisation(opts: {
        warehouseId: string;
        organisationId?: string;
        useTimeWindows?: boolean;
        setOffOverrides?: SetOffOverride[];
    }): Promise<{ optimisationId: string | null; skipReason: string | null }> {
        const runner = await this.db.beginTransaction();
        try {
            const build = await this.db.buildOptimizationRequest(runner, opts);

            if (
                build.request.jobs.length === 0 &&
                build.pinnedRoutes.length === 0
            ) {
                await runner.rollbackTransaction();
                return { optimisationId: null, skipReason: build.skipReason };
            }

            let optimisationId: string | null = null;

            if (build.request.jobs.length > 0) {
                const response = await this.vroom.solve(build.request);
                optimisationId = await this.db.insertOptimisedRoutes(
                    runner,
                    build.request,
                    response,
                    build.vehicleMap,
                    build.jobMap,
                    build.driverMap,
                    {
                        organisationId: build.organisationId,
                        timeWindowed: build.timeWindowed,
                    },
                );
            }

            for (const pinned of build.pinnedRoutes) {
                const response = await this.vroom.solve(pinned.request);
                const result = await this.db.insertAdhocRoutes(
                    runner,
                    pinned.request,
                    response,
                    pinned.jobPackageMap,
                    {
                        organisationId: build.organisationId ?? '',
                        scheduledStart: pinned.scheduledStart,
                        driverId: pinned.driverId,
                        vehicleId: pinned.vehicleId,
                    },
                );
                optimisationId ??= result.optimizationId;
            }

            await runner.commitTransaction();
            return { optimisationId, skipReason: null };
        } catch (err) {
            await runner.rollbackTransaction();
            throw err;
        } finally {
            await runner.release();
        }
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    private async loadShift(optimisationId: string): Promise<ShiftRow | null> {
        const rows: ShiftRow[] = await this.dataSource.query(
            `SELECT v.id,
                    v.status,
                    v.organisation_id,
                    v.warehouse_id,
                    v.driver_id,
                    v.vehicle_id,
                    v.revision,
                    v.scheduled_start,
                    veh.vehicle_gross_limits,
                    vt.ors_vehicle_type,
                    ST_X(w.warehouse_location::geometry) AS depot_lon,
                    ST_Y(w.warehouse_location::geometry) AS depot_lat
               FROM vrp_optimization v
               LEFT JOIN vehicles     veh ON veh.id = v.vehicle_id
               LEFT JOIN vehicle_type vt  ON vt.id  = veh.vehicle_type
               LEFT JOIN warehouse    w   ON w.id   = v.warehouse_id
              WHERE v.id = $1`,
            [optimisationId],
        );
        return rows[0] ?? null;
    }

    private async loadShiftPackages(
        optimisationId: string,
    ): Promise<ShiftPackageRow[]> {
        return this.dataSource.query(
            `SELECT p.id,
                    pd.weight_kg,
                    pdw.scheduled_arrival,
                    ST_X(c.customer_location::geometry) AS lon,
                    ST_Y(c.customer_location::geometry) AS lat
               FROM packages p
               LEFT JOIN package_dimensions      pd  ON pd.package_id  = p.id
               LEFT JOIN package_delivery_window pdw ON pdw.package_id = p.id
               LEFT JOIN customer                c   ON c.id = p.to_customer
              WHERE p.optimisation_id = $1
              ORDER BY p.created_at`,
            [optimisationId],
        );
    }

    private capacityGrams(grossLimits: string | number | null): number {
        const kg =
            typeof grossLimits === 'string' ? Number(grossLimits) : grossLimits;
        return (Number.isFinite(kg) && kg ? Number(kg) : 1000) * 1000;
    }

    private weightGrams(weightKg: string | number | null): number {
        const kg = typeof weightKg === 'string' ? Number(weightKg) : weightKg;
        return Number.isFinite(kg) && kg ? Math.round(Number(kg) * 1000) : 1;
    }
}
