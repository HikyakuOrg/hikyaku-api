import {
    ConflictException,
    Injectable,
    Logger,
    OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryRunner, Repository } from 'typeorm';
import { Package } from 'src/entities/package.entity';
import { PackageAssignment } from 'src/entities/package-assignment.entity';
import { PackageStatus } from 'src/entities/package-status.entity';
import { VrpOptimization } from 'src/entities/vrp-optimization.entity';
import { VrpRoute } from 'src/entities/vrp-route.entity';
import { VrpSolution } from 'src/entities/vrp-solution.entity';
import type { OptimizationResponse } from '../vroom/vroom.types';
import { orsProfileToValhallaCosting } from '../vroom/profile-map';
import type {
    AssignmentRow,
    BuildOptions,
    BuildResult,
    PackageRow,
    StepInsertRow,
} from './database.types';

/** Service time per delivery stop, in seconds (15 minutes). Hardcoded for now. */
export const TIME_PER_STOP = 900;

/** Reload/turnaround buffer added after a vehicle returns, in seconds (30 min). */
const SETOFF_BUFFER_SECONDS = 1800;

/** Width of the vehicle operating window once it has set off, in seconds (12h). */
export const SHIFT_WINDOW_SECONDS = 12 * 60 * 60;

@Injectable()
export class DatabaseService implements OnApplicationBootstrap {
    private readonly logger = new Logger(DatabaseService.name);
    private pendingStatusId!: number;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @InjectRepository(PackageStatus) private readonly packageStatusRepo: Repository<PackageStatus>,
        @InjectRepository(Package) private readonly packageRepo: Repository<Package>,
        @InjectRepository(PackageAssignment) private readonly packageAssignmentRepo: Repository<PackageAssignment>,
        @InjectRepository(VrpOptimization) private readonly vrpOptimizationRepo: Repository<VrpOptimization>,
        @InjectRepository(VrpSolution) private readonly vrpSolutionRepo: Repository<VrpSolution>,
        @InjectRepository(VrpRoute) private readonly vrpRouteRepo: Repository<VrpRoute>,
    ) { }

    async onApplicationBootstrap(): Promise<void> {
        const status = await this.packageStatusRepo.findOneBy({ enums: 'PENDING' });
        if (!status) {
            throw new Error('package_status row with enums = \'PENDING\' not found.');
        }
        this.pendingStatusId = status.id;
        this.logger.log(`Resolved PENDING status id: ${this.pendingStatusId}`);
    }

    /**
     * Creates a QueryRunner, starts a transaction, and returns it.
     * The caller is responsible for committing or rolling back.
     */
    async beginTransaction(): Promise<QueryRunner> {
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        return runner;
    }

    /** Executes a parameterised SQL query outside of a transaction. */
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
        return this.dataSource.query(sql, params);
    }

    /**
     * Fetches pending unassigned packages and active driver–vehicle assignments,
     * returning a ready-to-send VROOM optimization request plus the lookup maps
     * needed by insertOptimisedRoutes.
     *
     * The SELECT on packages uses FOR UPDATE OF p SKIP LOCKED so that concurrent
     * scheduler workers never process the same packages simultaneously — this
     * addresses the race-condition TODO in the original Deno implementation.
     *
     * When `opts.warehouseId` is set the run is scoped to that warehouse (the
     * cross-org leak fix); when `opts.useTimeWindows` is set each vehicle gets a
     * VROOM time_window encoding its earliest set-off, so returning vehicles can
     * be planned for a later wave (on-demand multi-wave dispatch).
     *
     * @param runner  Must already have an open transaction (beginTransaction).
     */
    async buildOptimizationRequest(
        runner: QueryRunner,
        opts: BuildOptions = {},
    ): Promise<BuildResult> {
        const now = opts.now ?? new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        // 0. Resolve the warehouse (coords + owning org) up front when scoped.
        let warehouseCoords: [number, number] | null = null;
        let organisationId: string | null = opts.organisationId ?? null;

        if (opts.warehouseId) {
            const whRows: {
                organisation_id: string;
                warehouse_lon: number | null;
                warehouse_lat: number | null;
            }[] = await runner.query(
                `
        SELECT
          w.organisation_id,
          ST_X(w.warehouse_location::geometry) AS warehouse_lon,
          ST_Y(w.warehouse_location::geometry) AS warehouse_lat
        FROM warehouse w
        WHERE w.id = $1
        `,
                [opts.warehouseId],
            );
            const wh = whRows[0];
            if (!wh) {
                throw new Error(`Warehouse ${opts.warehouseId} not found.`);
            }
            // Security: a passed organisationId must own the warehouse.
            if (organisationId && organisationId !== wh.organisation_id) {
                throw new Error('Warehouse does not belong to the requesting organisation.');
            }
            organisationId = wh.organisation_id;
            if (wh.warehouse_lon != null && wh.warehouse_lat != null) {
                warehouseCoords = [wh.warehouse_lon, wh.warehouse_lat];
            }
        }

        // 1. Fetch unassigned pending packages — locked for this transaction so
        //    a second concurrent worker will SKIP these rows entirely.
        // Current status is derived from the most recent package_timeline row
        // via a LATERAL subquery (packages has no status column directly).
        const packages: PackageRow[] = await runner.query(
            `
      SELECT
        p.id,
        p.tracking_number,
        p.created_at,
        p.warehouse_id,
        ST_X(w.warehouse_location::geometry)   AS warehouse_lon,
        ST_Y(w.warehouse_location::geometry)   AS warehouse_lat,
        pd.weight_kg,
        pdw.scheduled_arrival,
        ST_X(c.customer_location::geometry)    AS customer_lon,
        ST_Y(c.customer_location::geometry)    AS customer_lat
      FROM   packages                p
      JOIN   LATERAL (
               SELECT package_status
               FROM   package_timeline
               WHERE  package_id = p.id
               ORDER  BY created_at DESC
               LIMIT  1
             ) latest_status ON true
      LEFT   JOIN warehouse          w   ON w.id  = p.warehouse_id
      LEFT   JOIN package_assignment pa  ON pa.package_id = p.id
      LEFT   JOIN package_dimensions pd  ON pd.package_id = p.id
      LEFT   JOIN package_delivery_window pdw ON pdw.package_id = p.id
      JOIN   customer                c   ON c.id  = p.to_customer
      WHERE  latest_status.package_status = $1
        AND  p.optimisation_id   IS NULL
        AND  pa.package_id       IS NULL
        AND  ($2::uuid IS NULL OR p.warehouse_id = $2)
      FOR UPDATE OF p SKIP LOCKED
      `,
            [this.pendingStatusId, opts.warehouseId ?? null],
        );

        this.logger.debug(`Found ${packages.length} unassigned pending packages.`);

        // 2. Fetch active driver–vehicle assignments with vehicle/warehouse details.
        const assignments: AssignmentRow[] = await runner.query(
            `
      SELECT
        dva.driver_id,
        dva.vehicle_id,
        v.vehicle_gross_limits,
        vt.ors_vehicle_type,
        ST_X(w.warehouse_location::geometry) AS warehouse_lon,
        ST_Y(w.warehouse_location::geometry) AS warehouse_lat
      FROM  driver_vehicle_assignment dva
      JOIN  vehicles                  v   ON v.id  = dva.vehicle_id
      JOIN  vehicle_type              vt  ON vt.id = v.vehicle_type
      LEFT  JOIN warehouse            w   ON w.id  = v.warehouse_id
      WHERE v.is_deleted = false
        AND ($1::uuid IS NULL OR v.warehouse_id = $1)
      `,
            [opts.warehouseId ?? null],
        );

        this.logger.debug(`Found ${assignments.length} driver–vehicle assignments.`);

        // 3. Resolve warehouse coordinates: prefer the scoped warehouse, then
        //    packages, then vehicles.
        if (!warehouseCoords) {
            for (const pkg of packages) {
                if (pkg.warehouse_lon != null && pkg.warehouse_lat != null) {
                    warehouseCoords = [pkg.warehouse_lon, pkg.warehouse_lat];
                    break;
                }
            }
        }

        if (!warehouseCoords) {
            for (const a of assignments) {
                if (a.warehouse_lon != null && a.warehouse_lat != null) {
                    warehouseCoords = [a.warehouse_lon, a.warehouse_lat];
                    break;
                }
            }
        }

        if (!warehouseCoords) {
            throw new Error(
                'Could not determine warehouse location for routing. ' +
                'Ensure packages/vehicles are assigned to a warehouse with a location.',
            );
        }

        // 3b. On-demand: compute each vehicle's earliest set-off (epoch seconds).
        const setOffByVehicle = opts.useTimeWindows
            ? await this.computeVehicleSetOffs(
                runner,
                assignments.map((a) => a.vehicle_id),
                opts.setOffOverrides ?? [],
                now,
            )
            : {};

        // 4. Build vehicles array.
        const vehicles: BuildResult['request']['vehicles'] = [];
        const vehicleMap: Record<number, string> = {};
        const driverMap: Record<number, string> = {};

        assignments.forEach((a, index) => {
            const vehicleNumericId = index + 1;
            const capacity =
                typeof a.vehicle_gross_limits === 'number' ? a.vehicle_gross_limits : 1000;
            const vehicle: BuildResult['request']['vehicles'][number] = {
                id: vehicleNumericId,
                profile: orsProfileToValhallaCosting(a.ors_vehicle_type),
                start: warehouseCoords!,
                end: warehouseCoords!,
                capacity: [capacity],
            };
            if (opts.useTimeWindows) {
                const setOff = setOffByVehicle[a.vehicle_id] ?? Math.floor(now.getTime() / 1000);
                vehicle.time_window = [setOff, setOff + SHIFT_WINDOW_SECONDS];
            }
            vehicles.push(vehicle);
            vehicleMap[vehicleNumericId] = a.vehicle_id;
            if (a.driver_id) {
                driverMap[vehicleNumericId] = a.driver_id;
            }
        });

        // 5. Build jobs array — apply priority rules and skip future-due packages.
        const jobs: BuildResult['request']['jobs'] = [];
        const jobMap: Record<number, string> = {};

        packages.forEach((pkg, index) => {
            if (pkg.customer_lon == null || pkg.customer_lat == null) return;

            // VROOM expects weight in grams for capacity matching.
            const weight =
                typeof pkg.weight_kg === 'number' ? pkg.weight_kg * 1000 : 1;

            let priority = 0; // null scheduled_arrival → lowest priority
            let skipProcessing = false;

            if (pkg.scheduled_arrival) {
                const arrivalDate = new Date(pkg.scheduled_arrival);
                if (arrivalDate < startOfDay) {
                    priority = 100; // past-due: highest priority
                } else if (arrivalDate <= endOfDay) {
                    priority = 50; // due today: high priority
                } else {
                    skipProcessing = true; // future: skip tonight
                }
            }

            if (skipProcessing) return;

            const jobNumericId = index + 1;
            jobs.push({
                id: jobNumericId,
                service: TIME_PER_STOP,
                location: [pkg.customer_lon, pkg.customer_lat],
                amount: [weight],
                priority,
            });
            jobMap[jobNumericId] = pkg.id;
        });

        return {
            request: { jobs, vehicles },
            vehicleMap,
            jobMap,
            driverMap,
            organisationId,
            timeWindowed: !!opts.useTimeWindows,
        };
    }

    /**
     * Computes the earliest set-off time (epoch seconds) per vehicle for an
     * on-demand run:
     *   - a dispatcher override always wins;
     *   - a vehicle with an active (not fully delivered) route departs again
     *     SETOFF_BUFFER_SECONDS after its estimated RETURN. Return is derived
     *     from when it actually left (the first package's IN_TRANSIT timeline
     *     row) — falling back to its planned scheduled_departure, then now —
     *     plus that route's end-step arrival (total route duration in seconds);
     *   - an idle vehicle departs now.
     *
     * The active route's in-progress packages are never re-touched (the
     * pending-only query above excludes them); this only schedules the NEXT wave.
     */
    private async computeVehicleSetOffs(
        runner: QueryRunner,
        vehicleIds: string[],
        overrides: { vehicleId: string; setOffAt: string }[],
        now: Date,
    ): Promise<Record<string, number>> {
        const nowEpoch = Math.floor(now.getTime() / 1000);
        const result: Record<string, number> = {};
        for (const id of vehicleIds) result[id] = nowEpoch; // idle default

        if (vehicleIds.length > 0) {
            // One row per (vehicle, active route): the route's return reference
            // and its total duration. HAVING drops fully-delivered routes.
            const rows: {
                vehicle_id: string;
                end_arrival: number | null;
                return_ref: string | null;
            }[] = await runner.query(
                `
        WITH active AS (
          SELECT
            pa.vehicle_id,
            rs.route_id,
            MIN(it.in_transit_at)        AS first_in_transit_at,
            MIN(pdw.scheduled_departure) AS scheduled_departure_min,
            bool_and(latest.enums IN ('DELIVERED', 'FAILED')) AS all_terminal
          FROM vrp_route_step rs
          JOIN package_assignment pa ON pa.package_id = rs.package_id
          LEFT JOIN package_delivery_window pdw ON pdw.package_id = rs.package_id
          LEFT JOIN LATERAL (
            SELECT ps.enums
            FROM package_timeline pt
            JOIN package_status ps ON ps.id = pt.package_status
            WHERE pt.package_id = rs.package_id
            ORDER BY pt.created_at DESC, pt.id DESC
            LIMIT 1
          ) latest ON true
          LEFT JOIN LATERAL (
            SELECT MIN(pt.created_at) AS in_transit_at
            FROM package_timeline pt
            JOIN package_status ps ON ps.id = pt.package_status
            WHERE pt.package_id = rs.package_id AND ps.enums = 'IN_TRANSIT'
          ) it ON true
          WHERE rs.type = 'job'
            AND pa.vehicle_id = ANY($1::uuid[])
          GROUP BY pa.vehicle_id, rs.route_id
        )
        SELECT
          a.vehicle_id,
          e.arrival AS end_arrival,
          COALESCE(a.first_in_transit_at, a.scheduled_departure_min) AS return_ref
        FROM active a
        LEFT JOIN LATERAL (
          SELECT arrival
          FROM vrp_route_step
          WHERE route_id = a.route_id AND type = 'end'
          LIMIT 1
        ) e ON true
        WHERE a.all_terminal = false
        `,
                [vehicleIds],
            );

            for (const row of rows) {
                const refEpoch = row.return_ref
                    ? Math.floor(new Date(row.return_ref).getTime() / 1000)
                    : nowEpoch;
                const returnEpoch = refEpoch + (row.end_arrival ?? 0);
                const setOff = returnEpoch + SETOFF_BUFFER_SECONDS;
                // A vehicle may carry more than one active route — take the
                // latest return so its next wave never overlaps either.
                result[row.vehicle_id] = Math.max(result[row.vehicle_id] ?? nowEpoch, setOff);
            }
        }

        // Dispatcher overrides win outright.
        for (const o of overrides) {
            const epoch = Math.floor(new Date(o.setOffAt).getTime() / 1000);
            if (!Number.isNaN(epoch)) result[o.vehicleId] = epoch;
        }

        return result;
    }

    /**
     * Persists the VROOM optimisation result atomically inside `runner`.
     *
     * Insert sequence (mirrors the original database.ts, now fully transactional):
     *   1. vrp_optimization   — raw request / response snapshot (+ organisation_id)
     *   2. vrp_solution       — summary statistics
     *   3. Per route:
     *      a. vrp_route
     *      b. package_assignment  (upsert — FK parent for vrp_route_step)
     *      c. vrp_route_step      (batch insert)
     *      d. package_delivery_window.scheduled_departure  (when time-windowed)
     *   4. packages.optimisation_id  — marks packages as processed, prevents
     *                                  re-inclusion in future runs
     *
     * When `opts.timeWindowed` is true, VROOM reports step.arrival as absolute
     * epoch seconds; we normalise it back to relative-from-departure seconds
     * (subtracting the route's own start-step arrival) so the stored value stays
     * consistent with the manual-shift flow and the dashboard's interpretation.
     *
     * @param runner  Must already have an open transaction (beginTransaction).
     */
    async insertOptimisedRoutes(
        runner: QueryRunner,
        requestPayload: BuildResult['request'],
        optimisationResponse: OptimizationResponse,
        vehicleMap: Record<number, string>,
        jobMap: Record<number, string>,
        driverMap: Record<number, string>,
        opts: { organisationId?: string | null; timeWindowed?: boolean } = {},
    ): Promise<string> {
        const optimisedPackageIds = new Set<string>();

        // 1. vrp_optimization — store raw request/response for auditability.
        const optResult = await runner.manager.insert(VrpOptimization, {
            provider: 'vroom',
            request: requestPayload,
            response: optimisationResponse,
            organisationId: opts.organisationId ?? null,
        });
        const optimizationId: string = optResult.identifiers[0].id;

        // 2. vrp_solution — summary stats from the VROOM response.
        const summary = optimisationResponse.summary ?? {};
        // computing_times is returned by VROOM but absent from the typed interface.
        const computingTimes =
            (summary as Record<string, unknown>)?.computing_times as
            | { loading?: number; solving?: number; routing?: number }
            | undefined;

        const solResult = await runner.manager.insert(VrpSolution, {
            optimizationId,
            cost: summary.cost ?? null,
            routesCount: summary.routes ?? null,
            unassignedCount: summary.unassigned ?? null,
            delivery: summary.delivery != null ? [summary.delivery] : null,
            amount: (summary as Record<string, unknown>).amount as number[] ?? null,
            pickup: summary.pickup != null ? [summary.pickup] : null,
            setup: summary.setup ?? null,
            service: summary.service ?? null,
            duration: summary.duration ?? null,
            waitingTime: summary.waiting_time ?? null,
            priority: summary.priority ?? null,
            loadingTime: computingTimes?.loading ?? 0,
            solvingTime: computingTimes?.solving ?? 0,
            routingTime: computingTimes?.routing ?? 0,
        });
        const solutionId: string = solResult.identifiers[0].id;

        // Collected across all routes; written after the step inserts.
        const departureByPackage: { package_id: string; departure: string }[] = [];

        // 3. Routes.
        for (const route of optimisationResponse.routes ?? []) {
            // 3a. vrp_route.
            const routeExt = route as typeof route & {
                amount?: number[];
                setup?: number;
                priority?: number;
            };

            const routeResult = await runner.manager.insert(VrpRoute, {
                solutionId,
                cost: route.cost ?? null,
                delivery: route.delivery ?? null,
                amount: routeExt.amount ?? null,
                pickup: route.pickup ?? null,
                setup: routeExt.setup ?? null,
                service: route.service ?? null,
                duration: route.duration ?? null,
                waitingTime: route.waiting_time ?? null,
                priority: routeExt.priority ?? null,
            });
            const routeId: string = routeResult.identifiers[0].id;

            // When time-windowed, arrivals are absolute epoch; the start step's
            // arrival is this vehicle's actual departure. Subtract it to store
            // relative-from-departure seconds (and reuse it as scheduled_departure).
            const startStep = route.steps.find((s) => s.type === 'start');
            const departureEpoch =
                opts.timeWindowed && startStep?.arrival != null ? startStep.arrival : null;
            const departureIso =
                departureEpoch != null ? new Date(departureEpoch * 1000).toISOString() : null;

            // Collect steps and package assignments for this route.
            const stepsPayload: StepInsertRow[] = [];
            const routeAssignments: {
                package_id: string;
                vehicle_id: string;
                driver_id: string;
            }[] = [];

            for (const [index, step] of route.steps.entries()) {
                if (!step.location) continue;

                if (step.type === 'job' && (!step.id || !jobMap[step.id])) {
                    throw new Error(
                        `Missing package mapping for job id ${step.id ?? '(unknown)'}`,
                    );
                }

                const [lon, lat] = step.location;
                let pkgId: string | null = null;

                if (step.type === 'job' && step.id) {
                    pkgId = jobMap[step.id];
                    optimisedPackageIds.add(pkgId);
                    routeAssignments.push({
                        package_id: pkgId,
                        vehicle_id: vehicleMap[route.vehicle],
                        driver_id: driverMap[route.vehicle],
                    });
                    if (departureIso) {
                        departureByPackage.push({ package_id: pkgId, departure: departureIso });
                    }
                }

                // Normalise absolute-epoch arrivals back to relative seconds.
                const arrival =
                    step.arrival == null
                        ? null
                        : departureEpoch != null
                            ? step.arrival - departureEpoch
                            : step.arrival;

                stepsPayload.push({
                    route_id: routeId,
                    step_index: index,
                    type: step.type,
                    solution_id: solutionId,
                    package_id: pkgId,
                    lon,
                    lat,
                    arrival,
                    duration: step.duration ?? null,
                    setup: step.setup ?? null,
                    service: step.service ?? null,
                    waiting_time: step.waiting_time ?? null,
                    // step.load is typed as number in vroom.types but VROOM returns an
                    // array; store it directly — the column is int4[].
                    load:
                        step.load != null
                            ? Array.isArray(step.load)
                                ? (step.load as number[])
                                : [step.load as unknown as number]
                            : null,
                });
            }

            // 3b. package_assignment must be inserted before vrp_route_step (FK).
            if (routeAssignments.length > 0) {
                await this.upsertPackageAssignments(runner, routeAssignments);
            }

            // 3c. vrp_route_step — single batch INSERT.
            if (stepsPayload.length > 0) {
                await this.batchInsertRouteSteps(runner, stepsPayload);
            }
        }

        // 3d. Record planned departures so the availability filter + UI see the
        //     vehicle as busy. Never overwrites the booking scheduled_arrival.
        if (departureByPackage.length > 0) {
            await this.upsertScheduledDepartures(runner, departureByPackage);
        }

        // 4. Mark all processed packages so they are excluded from future runs.
        if (optimisedPackageIds.size > 0) {
            await runner.manager.update(
                Package,
                { id: In(Array.from(optimisedPackageIds)) },
                { optimisationId: optimizationId },
            );
        }

        return optimizationId;
    }

    /**
     * Persists an ad-hoc (mobile) optimisation result atomically inside `runner`.
     *
     * The jobs are packages the mobile app already created and picked, so — like
     * insertOptimisedRoutes — the routed packages are claimed by stamping
     * packages.optimisation_id. The caller supplies the driver/vehicle for this
     * shift (validated to share a warehouse, per the enforce_driver_vehicle_warehouse
     * trigger on package_assignment), so job steps get package_id set and
     * package_assignment rows upserted exactly like the on-demand pipeline.
     * package_delivery_window is left untouched, matching insertOptimisedRoutes'
     * non-time-windowed behaviour.
     *
     * `jobPackageMap` resolves VROOM job ids back to package ids — both to report
     * unassigned packages and to determine which packages to claim.
     *
     * Only packages VROOM actually routed are claimed. Ones it could not fit stay
     * optimisation_id IS NULL so they remain pickable for another shift (there is
     * no detach endpoint yet, so claiming them would strand them).
     *
     * Ad-hoc runs always carry a vehicle time_window, so VROOM reports
     * step.arrival as ABSOLUTE epoch seconds; we normalise it back to
     * relative-from-departure seconds (subtracting the route's start-step
     * arrival), matching the stored convention used everywhere else.
     *
     * @param runner  Must already have an open transaction (beginTransaction).
     * @throws ConflictException if a package was claimed concurrently.
     */
    async insertAdhocRoutes(
        runner: QueryRunner,
        requestForDb: object,
        response: OptimizationResponse,
        jobPackageMap: Record<number, string>,
        opts: { organisationId: string; scheduledStart: Date; driverId: string; vehicleId: string },
    ): Promise<{
        optimizationId: string;
        routeId: string | null;
        unassignedPackageIds: string[];
    }> {
        // 1. vrp_optimization — raw request/response snapshot for auditability.
        const optResult = await runner.manager.insert(VrpOptimization, {
            provider: 'vroom',
            request: requestForDb,
            response,
            organisationId: opts.organisationId,
            scheduledStart: opts.scheduledStart,
        });
        const optimizationId: string = optResult.identifiers[0].id;

        // 2. vrp_solution — summary stats from the VROOM response.
        const summary = response.summary ?? {};
        // computing_times is returned by VROOM but absent from the typed interface.
        const computingTimes =
            (summary as Record<string, unknown>)?.computing_times as
            | { loading?: number; solving?: number; routing?: number }
            | undefined;

        const solResult = await runner.manager.insert(VrpSolution, {
            optimizationId,
            cost: summary.cost ?? null,
            routesCount: summary.routes ?? null,
            unassignedCount: summary.unassigned ?? null,
            delivery: summary.delivery != null ? [summary.delivery] : null,
            amount: (summary as Record<string, unknown>).amount as number[] ?? null,
            pickup: summary.pickup != null ? [summary.pickup] : null,
            setup: summary.setup ?? null,
            service: summary.service ?? null,
            duration: summary.duration ?? null,
            waitingTime: summary.waiting_time ?? null,
            priority: summary.priority ?? null,
            loadingTime: computingTimes?.loading ?? 0,
            solvingTime: computingTimes?.solving ?? 0,
            routingTime: computingTimes?.routing ?? 0,
        });
        const solutionId: string = solResult.identifiers[0].id;

        // 3. Single route (absent when every package is unassigned).
        let routeId: string | null = null;
        const routedPackageIds = new Set<string>();
        const route = response.routes?.[0];
        if (route) {
            const routeExt = route as typeof route & {
                amount?: number[];
                setup?: number;
                priority?: number;
            };

            const routeResult = await runner.manager.insert(VrpRoute, {
                solutionId,
                cost: route.cost ?? null,
                delivery: route.delivery ?? null,
                amount: routeExt.amount ?? null,
                pickup: route.pickup ?? null,
                setup: routeExt.setup ?? null,
                service: route.service ?? null,
                duration: route.duration ?? null,
                waitingTime: route.waiting_time ?? null,
                priority: routeExt.priority ?? null,
            });
            const insertedRouteId: string = routeResult.identifiers[0].id;
            routeId = insertedRouteId;

            // Arrivals are absolute epoch (time_window is always set for ad-hoc);
            // the start step's arrival is the vehicle's departure. Subtract it to
            // store relative-from-departure seconds.
            const startStep = route.steps.find((s) => s.type === 'start');
            const departureEpoch = startStep?.arrival ?? null;

            const stepsPayload: StepInsertRow[] = [];
            const routeAssignments: {
                package_id: string;
                vehicle_id: string;
                driver_id: string;
            }[] = [];
            for (const [index, step] of route.steps.entries()) {
                if (!step.location) continue;
                const [lon, lat] = step.location;

                let pkgId: string | null = null;
                if (step.type === 'job') {
                    pkgId = (step.id != null ? jobPackageMap[step.id] : undefined) ?? null;
                    if (!pkgId) {
                        throw new Error(
                            `Missing package mapping for job id ${step.id ?? '(unknown)'}`,
                        );
                    }
                    routedPackageIds.add(pkgId);
                    routeAssignments.push({
                        package_id: pkgId,
                        vehicle_id: opts.vehicleId,
                        driver_id: opts.driverId,
                    });
                }

                const arrival =
                    step.arrival == null
                        ? null
                        : departureEpoch != null
                            ? step.arrival - departureEpoch
                            : step.arrival;

                stepsPayload.push({
                    route_id: insertedRouteId,
                    step_index: index,
                    type: step.type,
                    solution_id: solutionId,
                    package_id: pkgId,
                    lon,
                    lat,
                    arrival,
                    duration: step.duration ?? null,
                    setup: step.setup ?? null,
                    service: step.service ?? null,
                    waiting_time: step.waiting_time ?? null,
                    load:
                        step.load != null
                            ? Array.isArray(step.load)
                                ? (step.load as number[])
                                : [step.load as unknown as number]
                            : null,
                });
            }

            // package_assignment must be inserted before vrp_route_step (FK).
            if (routeAssignments.length > 0) {
                await this.upsertPackageAssignments(runner, routeAssignments);
            }

            if (stepsPayload.length > 0) {
                await this.batchInsertRouteSteps(runner, stepsPayload);
            }
        }

        // 4. vrp_unassigned_job — packages VROOM could not fit.
        const unassignedPackageIds: string[] = [];
        for (const u of response.unassigned ?? []) {
            const packageId = jobPackageMap[u.id];
            if (packageId) unassignedPackageIds.push(packageId);

            const loc = u.location;
            if (loc && loc.length === 2) {
                await runner.query(
                    `INSERT INTO vrp_unassigned_job (solution_id, job_id, location, type)
                     VALUES ($1, $2, ST_SetSRID(ST_Point($3, $4), 4326), $5)`,
                    [solutionId, u.id, loc[0], loc[1], 'job'],
                );
            } else {
                await runner.query(
                    `INSERT INTO vrp_unassigned_job (solution_id, job_id, type)
                     VALUES ($1, $2, $3)`,
                    [solutionId, u.id, 'job'],
                );
            }
        }

        // 5. Claim the routed packages. The optimisation_id IS NULL guard makes
        //    this the point of truth rather than the caller's earlier validation:
        //    if another request claimed one in between, fewer rows come back and
        //    we abort so the caller's transaction rolls the whole run back.
        if (routedPackageIds.size > 0) {
            const ids = Array.from(routedPackageIds);
            const claimed: { id: string }[] = await runner.query(
                `UPDATE packages
                    SET optimisation_id = $1
                  WHERE id = ANY($2::uuid[])
                    AND optimisation_id IS NULL
                RETURNING id`,
                [optimizationId, ids],
            );
            if (claimed.length < ids.length) {
                const lost = ids.filter((id) => !claimed.some((c) => c.id === id));
                throw new ConflictException(
                    `Package(s) claimed by another optimisation while this one was solving: ${lost.join(', ')}`,
                );
            }
        }

        return { optimizationId, routeId, unassignedPackageIds };
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Upserts package_assignment rows.
     * Uses ON CONFLICT so re-running the optimiser for the same packages is safe.
     */
    private async upsertPackageAssignments(
        runner: QueryRunner,
        assignments: { package_id: string; vehicle_id: string; driver_id: string }[],
    ): Promise<void> {
        await runner.manager.upsert(
            PackageAssignment,
            assignments.map((a) => ({
                packageId: a.package_id,
                vehicleId: a.vehicle_id,
                driverId: a.driver_id,
            })),
            ['packageId'],
        );
    }

    /**
     * Upserts package_delivery_window.scheduled_departure for the given packages.
     * Only the departure column is touched — scheduled_arrival (the booking
     * deadline) is left untouched.
     */
    private async upsertScheduledDepartures(
        runner: QueryRunner,
        rows: { package_id: string; departure: string }[],
    ): Promise<void> {
        const placeholders = rows
            .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::timestamptz)`)
            .join(', ');
        const params = rows.flatMap((r) => [r.package_id, r.departure]);
        await runner.query(
            `INSERT INTO package_delivery_window (package_id, scheduled_departure)
             VALUES ${placeholders}
             ON CONFLICT (package_id)
             DO UPDATE SET scheduled_departure = EXCLUDED.scheduled_departure`,
            params,
        );
    }

    /**
     * Batch-inserts vrp_route_step rows in a single statement.
     * Each row uses ST_SetSRID(ST_Point($lon, $lat), 4326) for the geometry
     * column, passing coordinates as separate typed parameters.
     *
     * Column order (13 params per row):
     *   route_id, step_index, type, solution_id, package_id,
     *   lon, lat (→ geometry), arrival, duration, setup, service,
     *   waiting_time, load
     */
    private async batchInsertRouteSteps(
        runner: QueryRunner,
        steps: StepInsertRow[],
    ): Promise<void> {
        const PARAMS_PER_ROW = 13;

        const placeholders = steps
            .map((_, i) => {
                const b = i * PARAMS_PER_ROW;
                return (
                    `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},` +
                    `ST_SetSRID(ST_Point($${b + 6},$${b + 7}),4326),` +
                    `$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`
                );
            })
            .join(', ');

        const params = steps.flatMap((s) => [
            s.route_id,      // 1
            s.step_index,    // 2
            s.type,          // 3
            s.solution_id,   // 4
            s.package_id,    // 5
            s.lon,           // 6  → ST_Point arg
            s.lat,           // 7  → ST_Point arg
            s.arrival,       // 8
            s.duration,      // 9
            s.setup,         // 10
            s.service,       // 11
            s.waiting_time,  // 12
            s.load,          // 13
        ]);

        await runner.query(
            `INSERT INTO vrp_route_step (
         route_id, step_index, type, solution_id, package_id,
         location,
         arrival, duration, setup, service, waiting_time, load
       ) VALUES ${placeholders}`,
            params,
        );
    }
}
