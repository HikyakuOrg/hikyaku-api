import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { ValhallaService } from 'src/valhalla/valhalla.service';
import { QueueService } from './queue.service';
import { ShiftPlanWriter, type PlanStop } from './shift-plan.writer';
import {
    chooseBest,
    DISPATCH_LEAD_S,
    isGreyBand,
    legKey,
    pickVictims,
    tryInsert,
    type CandidateShift,
    type GeoPoint,
    type IncomingPackage,
    type InsertionContext,
    type InsertionResult,
    type InsertionSuccess,
    type RouteStop,
} from './insertion';
import { endOfLocalDayMs, localHourMs, localShiftDate } from './warehouse-clock';

/** Local hour a shift is assumed to set off when scheduled_start is unset. */
const DEFAULT_DEPARTURE_HOUR = 8;

/** How many times Phase B may lose the revision race before giving up. */
const MAX_REVISION_RETRIES = 2;

export type AssignmentOutcomeKind =
    | 'assigned'
    | 'assigned_new_shift'
    | 'deferred'
    | 'skipped';

export interface AssignedShiftResult {
    id: string;
    driverId: string | null;
    vehicleId: string | null;
    shiftDate: string;
    scheduledStart: string | null;
    stopIndex: number;
    estimatedArrival: string | null;
    revision: number;
}

export interface AssignmentOutcome {
    outcome: AssignmentOutcomeKind;
    reason: string | null;
    shift: AssignedShiftResult | null;
    evictedPackageIds: string[];
}

/** A package as the assignment engine needs it. */
interface PackageRow {
    id: string;
    organisation_id: string;
    warehouse_id: string | null;
    optimisation_id: string | null;
    eviction_count: number;
    created_at: string;
    weight_kg: string | number | null;
    scheduled_arrival: string | null;
    lon: number | null;
    lat: number | null;
}

interface WarehouseRow {
    id: string;
    timezone: string | null;
    lon: number | null;
    lat: number | null;
}

interface ShiftRow {
    id: string;
    revision: number;
    driver_id: string | null;
    vehicle_id: string | null;
    scheduled_start: string | null;
    shift_date: string;
    vehicle_gross_limits: string | number | null;
    ors_vehicle_type: string | null;
    route_id: string | null;
    solution_id: string | null;
}

interface StopRow {
    route_id: string;
    step_index: number;
    package_id: string;
    lon: number;
    lat: number;
    weight_kg: string | number | null;
    scheduled_arrival: string | null;
    eviction_count: number;
    created_at: string;
    status: string | null;
}

/** A loaded candidate plus the bits only the I/O layer needs. */
interface Candidate {
    shift: CandidateShift;
    profile: string;
    routeId: string | null;
    solutionId: string | null;
    shiftDate: string;
    scheduledStart: string | null;
}

const deferred = (reason: string): AssignmentOutcome => ({
    outcome: 'deferred',
    reason,
    shift: null,
    evictedPackageIds: [],
});

const skipped = (reason: string): AssignmentOutcome => ({
    outcome: 'skipped',
    reason,
    shift: null,
    evictedPackageIds: [],
});

/**
 * Tier 1: put a package on a shift, now.
 *
 * Two phases, and the split between them is the whole design.
 *
 *   PHASE A is unlocked and writes nothing. It loads the candidate shifts,
 *   runs the pure insertion algorithm over them, and — only when the winning
 *   estimate lands inside the grey band of a deadline — makes ONE Valhalla call
 *   to replace the estimate with a measurement. In the common case Phase A makes
 *   zero HTTP requests.
 *
 *   PHASE B takes a per-warehouse advisory lock, re-checks that the chosen
 *   shift has not moved since Phase A read it, writes, and commits. It is ~50 ms
 *   and CONTAINS NO NETWORK I/O. That constraint is not stylistic: one Valhalla
 *   call inside the lock turns a 150 ms hold into ~2 s and caps the warehouse at
 *   roughly half a package per second.
 *
 * Everything here can decline. A package that reaches no shift is `deferred`,
 * never an error — creation already committed in its own transaction, and a
 * package is never lost because no van had room for it.
 */
@Injectable()
export class AssignmentService {
    private readonly logger = new Logger(AssignmentService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly valhalla: ValhallaService,
        private readonly queue: QueueService,
        private readonly planWriter: ShiftPlanWriter,
    ) { }

    /**
     * `nightly` keeps the endpoints live but inert, so the API can deploy ahead
     * of the clients and the switch to `instant` is a config change rather than
     * a release. The cron removal is what makes `instant` the only mode.
     */
    get mode(): 'nightly' | 'instant' {
        return process.env.ASSIGNMENT_MODE === 'instant' ? 'instant' : 'nightly';
    }

    /**
     * Assigns one package. Never throws for an ordinary "did not fit" — see the
     * class comment.
     */
    async assign(
        organisationId: string,
        packageId: string,
        opts: { allowEviction?: boolean } = {},
    ): Promise<AssignmentOutcome> {
        if (this.mode !== 'instant') {
            return skipped('auto_assign_disabled');
        }

        try {
            return await this.assignInternal(organisationId, packageId, opts);
        } catch (err: unknown) {
            // Anything unexpected degrades to deferred rather than failing the
            // request the package was created by. The replan worker and the
            // dispatcher both still see it as PENDING.
            this.logger.error(
                `Assignment of package ${packageId} failed, deferring: ${String(err)}`,
            );
            return deferred(this.reasonFor(err));
        }
    }

    /**
     * Assigns a batch that shares a warehouse.
     *
     * Sequential on purpose. Each package is placed against the shifts as they
     * stand after the previous one landed, which is what stops a batch of 40
     * from all choosing the same "cheapest" shift and overflowing it. The saving
     * over N separate HTTP calls is real regardless: one request, one connection,
     * and the replan notification coalesces into a single solve.
     */
    async assignMany(
        organisationId: string,
        packageIds: string[],
    ): Promise<Map<string, AssignmentOutcome>> {
        const results = new Map<string, AssignmentOutcome>();
        for (const packageId of packageIds) {
            results.set(packageId, await this.assign(organisationId, packageId));
        }
        return results;
    }

    // ── Tier 1 ───────────────────────────────────────────────────────────────

    private async assignInternal(
        organisationId: string,
        packageId: string,
        opts: { allowEviction?: boolean },
    ): Promise<AssignmentOutcome> {
        const allowEviction = opts.allowEviction ?? true;

        const pkgRow = await this.loadPackage(organisationId, packageId);
        if (!pkgRow) return skipped('no_geocode');
        if (pkgRow.optimisation_id) {
            // Already on a shift. Re-assigning is an explicit endpoint.
            return skipped('auto_assign_disabled');
        }
        if (pkgRow.lon == null || pkgRow.lat == null) {
            return skipped('no_geocode');
        }
        if (!pkgRow.warehouse_id) {
            return deferred('no_capacity');
        }

        const warehouse = await this.loadWarehouse(organisationId, pkgRow.warehouse_id);
        if (!warehouse || warehouse.lon == null || warehouse.lat == null) {
            return deferred('no_capacity');
        }

        const now = new Date();
        const shiftDate = localShiftDate(now, warehouse.timezone);
        const ctx: InsertionContext = {
            nowMs: now.getTime(),
            shiftDayEndMs: endOfLocalDayMs(now, warehouse.timezone),
        };
        const pkg = this.toIncoming(pkgRow);
        const depot: GeoPoint = { lon: warehouse.lon, lat: warehouse.lat };

        for (let attempt = 0; attempt <= MAX_REVISION_RETRIES; attempt++) {
            // ── PHASE A: no lock, no writes ──────────────────────────────────
            const candidates = await this.loadCandidates(
                organisationId,
                warehouse.id,
                shiftDate,
                depot,
                now,
                warehouse.timezone,
            );

            const decision = await this.decide(candidates, pkg, ctx, allowEviction);

            // ── PHASE B: locked, no network I/O ──────────────────────────────
            const outcome = await this.commitDecision(
                organisationId,
                warehouse,
                shiftDate,
                depot,
                pkg,
                candidates,
                decision,
                ctx,
            );

            if (outcome !== 'retry') {
                if (outcome.evictedPackageIds.length > 0) {
                    await this.reassignVictims(organisationId, outcome.evictedPackageIds);
                }
                return outcome;
            }

            this.logger.debug(
                `Package ${packageId}: shift revision moved under us, retry ${attempt + 1}.`,
            );
        }

        return deferred('no_capacity');
    }

    /**
     * Phase A's answer: which shift, at which position, and at what cost — or
     * nothing. Pure decisions come from insertion.ts; the only I/O this method
     * can do is the single grey-band routing call.
     */
    private async decide(
        candidates: Candidate[],
        pkg: IncomingPackage,
        ctx: InsertionContext,
        allowEviction: boolean,
    ): Promise<
        | { kind: 'insert'; candidate: Candidate; insertion: InsertionSuccess }
        | { kind: 'evict'; candidate: Candidate; insertion: InsertionSuccess; victimIds: string[] }
        | { kind: 'none' }
    > {
        const stopCounts: Record<string, number> = {};
        const byId = new Map<string, Candidate>();
        for (const candidate of candidates) {
            stopCounts[candidate.shift.id] = candidate.shift.stops.length;
            byId.set(candidate.shift.id, candidate);
        }

        let results: InsertionResult[] = candidates.map((c) =>
            tryInsert(c.shift, pkg, ctx),
        );

        // The grey band: the estimate says it fits, but only just. A haversine
        // guess is not good enough to promise a customer on, so the winner — and
        // only the winner — is re-checked against the real road network. Still
        // Phase A, so still outside the lock.
        let best = chooseBest(results, stopCounts);
        if (best && isGreyBand(best)) {
            const candidate = byId.get(best.shiftId);
            if (candidate) {
                const measured = await this.measureLegs(candidate, best.order, pkg);
                if (measured) {
                    const rechecked = tryInsert(candidate.shift, pkg, {
                        ...ctx,
                        measuredLegs: measured,
                    });
                    results = results.map((r) =>
                        r.shiftId === best?.shiftId ? rechecked : r,
                    );
                    best = chooseBest(results, stopCounts);
                }
            }
        }

        if (best) {
            const candidate = byId.get(best.shiftId);
            if (candidate) return { kind: 'insert', candidate, insertion: best };
        }

        if (!allowEviction) return { kind: 'none' };

        // Last resort, and only after opening a new shift has been tried and
        // failed — see commitDecision, which reaches eviction only on the
        // no-free-pair path.
        for (const candidate of candidates) {
            const plan = pickVictims(candidate.shift, pkg, ctx);
            if (plan) {
                return {
                    kind: 'evict',
                    candidate,
                    insertion: plan.insertion,
                    victimIds: plan.victimIds,
                };
            }
        }

        return { kind: 'none' };
    }

    /**
     * Phase B. Everything from BEGIN to COMMIT, and nothing that touches the
     * network.
     *
     * Returns 'retry' when the chosen shift's revision moved between Phase A's
     * read and the lock being taken — someone else changed the plan we costed,
     * so the answer has to be recomputed rather than written over theirs.
     */
    private async commitDecision(
        organisationId: string,
        warehouse: WarehouseRow,
        shiftDate: string,
        depot: GeoPoint,
        pkg: IncomingPackage,
        candidates: Candidate[],
        decision: Awaited<ReturnType<AssignmentService['decide']>>,
        ctx: InsertionContext,
    ): Promise<AssignmentOutcome | 'retry'> {
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();

        try {
            // Serialises every assignment decision at this warehouse. Transaction
            // scoped, so it is released by COMMIT or ROLLBACK and cannot leak.
            await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
                `assign:${warehouse.id}`,
            ]);

            let target: Candidate | null = null;
            let insertion: InsertionSuccess | null = null;
            let evicted: string[] = [];
            let outcomeKind: AssignmentOutcomeKind = 'assigned';

            if (decision.kind === 'insert' || decision.kind === 'evict') {
                const fresh = await this.readRevision(runner, decision.candidate.shift.id);
                if (!fresh || fresh.revision !== decision.candidate.shift.revision) {
                    await runner.rollbackTransaction();
                    return 'retry';
                }
                if (fresh.status !== 'planned') {
                    await runner.rollbackTransaction();
                    return 'retry';
                }
                target = decision.candidate;
                insertion = decision.insertion;
                if (decision.kind === 'evict') {
                    evicted = decision.victimIds;
                    await this.planWriter.detach(runner, evicted, {
                        incrementEviction: true,
                    });
                    target = {
                        ...target,
                        shift: {
                            ...target.shift,
                            stops: target.shift.stops.filter(
                                (s) => !evicted.includes(s.packageId),
                            ),
                        },
                    };
                }
            } else {
                // Nothing fits. Open a new shift before evicting anybody — a
                // free van is always a better answer than taking someone else's
                // slot.
                const opened = await this.openShift(
                    runner,
                    organisationId,
                    warehouse,
                    shiftDate,
                    depot,
                    new Date(ctx.nowMs),
                );
                if (opened === 'allowance_exhausted') {
                    await runner.rollbackTransaction();
                    return deferred('shift_allowance_exhausted');
                }
                if (opened === null) {
                    await runner.rollbackTransaction();
                    return deferred(
                        candidates.length === 0 ? 'no_free_driver_vehicle' : 'no_capacity',
                    );
                }

                const attempt = tryInsert(opened.shift, pkg, ctx);
                if (!attempt.feasible) {
                    // An empty shift that cannot take one package means the
                    // package cannot be delivered inside a 12h window at all.
                    await runner.rollbackTransaction();
                    return deferred('deadline_infeasible');
                }
                target = opened;
                insertion = attempt;
                outcomeKind = 'assigned_new_shift';
            }

            if (target === null || insertion === null) {
                await runner.rollbackTransaction();
                return deferred('no_capacity');
            }

            const written = await this.persist(
                runner,
                target,
                pkg,
                insertion,
                decision.kind === 'evict' ? 'evict' : 'assign',
            );

            await this.queue.enqueueReplan(runner, {
                kind: 'replan',
                optimisationId: target.shift.id,
                warehouseId: warehouse.id,
                organisationId,
            });

            await runner.commitTransaction();

            return {
                outcome: outcomeKind,
                reason: null,
                shift: written,
                evictedPackageIds: evicted,
            };
        } catch (err: unknown) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            throw err;
        } finally {
            await runner.release();
        }
    }

    /** Writes the plan and returns the shift as the client should see it. */
    private async persist(
        runner: QueryRunner,
        candidate: Candidate,
        pkg: IncomingPackage,
        insertion: InsertionSuccess,
        reason: string,
    ): Promise<AssignedShiftResult> {
        const { routeId, solutionId } = candidate.routeId && candidate.solutionId
            ? { routeId: candidate.routeId, solutionId: candidate.solutionId }
            : await this.planWriter.ensureRoute(runner, candidate.shift.id);

        await this.planWriter.snapshotRevision(
            runner,
            candidate.shift.id,
            candidate.shift.revision,
            reason,
        );

        const byId = new Map(candidate.shift.stops.map((s) => [s.packageId, s]));
        const stops: PlanStop[] = insertion.order.map((packageId, i) => {
            const existing = byId.get(packageId);
            return {
                packageId,
                lon: existing?.lon ?? pkg.lon,
                lat: existing?.lat ?? pkg.lat,
                arrivalMs: insertion.arrivalsMs[i],
                weightG: existing?.weightG ?? pkg.weightG,
            };
        });

        await this.planWriter.writePlan(runner, {
            optimisationId: candidate.shift.id,
            routeId,
            solutionId,
            depot: candidate.shift.depot,
            departureMs: candidate.shift.departureMs,
            // Both are non-null for any shift Tier 1 can reach: the candidate
            // query requires them, and openShift sets them.
            driverId: candidate.shift.driverId ?? '',
            vehicleId: candidate.shift.vehicleId ?? '',
            stops,
            reason,
        });

        await this.planWriter.claimPackages(runner, candidate.shift.id, [pkg.id]);

        return {
            id: candidate.shift.id,
            driverId: candidate.shift.driverId,
            vehicleId: candidate.shift.vehicleId,
            shiftDate: candidate.shiftDate,
            scheduledStart: candidate.scheduledStart,
            stopIndex: insertion.index,
            estimatedArrival: new Date(insertion.arrivalsMs[insertion.index]).toISOString(),
            // The touch trigger bumped it as part of writePlan's UPDATE.
            revision: candidate.shift.revision + 1,
        };
    }

    /**
     * Opens a shift for an idle driver/vehicle pair.
     *
     * THE ONLY BILLED INSERT in the whole assignment path. It runs inside a
     * SAVEPOINT because enforce_shift_allowance() raises 23514 when the
     * organisation is out of free shifts with no payment method on file — and an
     * exception aborts the surrounding transaction, taking the advisory lock and
     * everything else with it. Rolling back to the savepoint turns a hard failure
     * into a `deferred` answer with the lock still held.
     */
    private async openShift(
        runner: QueryRunner,
        organisationId: string,
        warehouse: WarehouseRow,
        shiftDate: string,
        depot: GeoPoint,
        now: Date,
    ): Promise<Candidate | null | 'allowance_exhausted'> {
        const warehouseId = warehouse.id;
        const pairs: {
            driver_id: string;
            vehicle_id: string;
            vehicle_gross_limits: string | number | null;
            ors_vehicle_type: string | null;
        }[] = await runner.query(
            `SELECT dva.driver_id,
                    dva.vehicle_id,
                    v.vehicle_gross_limits,
                    vt.ors_vehicle_type
               FROM driver_vehicle_assignment dva
               JOIN vehicles     v  ON v.id  = dva.vehicle_id AND v.is_deleted = false
               JOIN vehicle_type vt ON vt.id = v.vehicle_type
               JOIN drivers      d  ON d.id  = dva.driver_id
              WHERE v.warehouse_id   = $1
                AND d.warehouse_id   = $1
                AND v.organisation_id = $2
                AND NOT EXISTS (
                    SELECT 1 FROM vrp_optimization o
                     WHERE o.shift_date = $3::date
                       AND o.status IN ('planned', 'dispatched')
                       AND (o.vehicle_id = dva.vehicle_id OR o.driver_id = dva.driver_id)
                )
              ORDER BY v.vehicle_gross_limits DESC, dva.vehicle_id
              LIMIT 1`,
            [warehouseId, organisationId, shiftDate],
        );

        const pair = pairs[0];
        if (!pair) return null;

        // Same default the candidate loader uses, so a package's ETA does not
        // jump depending on whether it landed on a new shift or an existing one.
        const departureMs = Math.max(
            now.getTime(),
            localHourMs(now, warehouse.timezone, DEFAULT_DEPARTURE_HOUR),
        );

        await runner.query(`SAVEPOINT open_shift`);
        let shiftId: string;
        try {
            const rows: { id: string; revision: number }[] = await runner.query(
                `INSERT INTO vrp_optimization
                     (provider, request, response, organisation_id,
                      status, driver_id, vehicle_id, warehouse_id, shift_date)
                 VALUES ('instant', $1::jsonb, '{}'::jsonb, $2,
                         'planned', $3, $4, $5, $6::date)
                 RETURNING id, revision`,
                [
                    JSON.stringify({ _meta: { opened_by: 'instant-assignment' } }),
                    organisationId,
                    pair.driver_id,
                    pair.vehicle_id,
                    warehouseId,
                    shiftDate,
                ],
            );
            await runner.query(`RELEASE SAVEPOINT open_shift`);
            shiftId = rows[0].id;
        } catch (err: unknown) {
            await runner.query(`ROLLBACK TO SAVEPOINT open_shift`);
            if (this.isAllowanceError(err)) return 'allowance_exhausted';
            // A unique-violation here means another writer opened a shift for
            // this pair between the SELECT and the INSERT. Not an error worth
            // surfacing — the next attempt will find their shift as a candidate.
            if (this.isUniqueViolation(err)) return null;
            throw err;
        }

        const { routeId, solutionId } = await this.planWriter.ensureRoute(runner, shiftId);

        return {
            shift: {
                id: shiftId,
                revision: 1,
                driverId: pair.driver_id,
                vehicleId: pair.vehicle_id,
                capacityG: this.capacityGrams(pair.vehicle_gross_limits),
                departureMs,
                depot,
                stops: [],
            },
            profile: pair.ors_vehicle_type ?? 'driving-car',
            routeId,
            solutionId,
            shiftDate,
            scheduledStart: null,
        };
    }

    // ── Loading ──────────────────────────────────────────────────────────────

    private async loadPackage(
        organisationId: string,
        packageId: string,
    ): Promise<PackageRow | null> {
        const rows: PackageRow[] = await this.dataSource.query(
            `SELECT p.id,
                    p.organisation_id,
                    p.warehouse_id,
                    p.optimisation_id,
                    p.eviction_count,
                    p.created_at,
                    pd.weight_kg,
                    pdw.scheduled_arrival,
                    ST_X(c.customer_location::geometry) AS lon,
                    ST_Y(c.customer_location::geometry) AS lat
               FROM packages p
               LEFT JOIN package_dimensions      pd  ON pd.package_id  = p.id
               LEFT JOIN package_delivery_window pdw ON pdw.package_id = p.id
               LEFT JOIN customer                c   ON c.id = p.to_customer
              WHERE p.id = $1 AND p.organisation_id = $2`,
            [packageId, organisationId],
        );
        return rows[0] ?? null;
    }

    private async loadWarehouse(
        organisationId: string,
        warehouseId: string,
    ): Promise<WarehouseRow | null> {
        const rows: WarehouseRow[] = await this.dataSource.query(
            `SELECT w.id,
                    w.timezone,
                    ST_X(w.warehouse_location::geometry) AS lon,
                    ST_Y(w.warehouse_location::geometry) AS lat
               FROM warehouse w
              WHERE w.id = $1 AND w.organisation_id = $2`,
            [warehouseId, organisationId],
        );
        return rows[0] ?? null;
    }

    /**
     * Every shift at this warehouse that is still open today, with its route.
     *
     * "Has not started" is exactly: status = 'planned' AND (scheduled_start IS
     * NULL OR scheduled_start > now() + the dispatch lead). A dispatched shift is
     * a van that has rolled, and the driver app flips it there by trigger the
     * moment any package goes IN_TRANSIT.
     */
    private async loadCandidates(
        organisationId: string,
        warehouseId: string,
        shiftDate: string,
        depot: GeoPoint,
        now: Date,
        timezone: string | null,
    ): Promise<Candidate[]> {
        const shiftRows: ShiftRow[] = await this.dataSource.query(
            `SELECT v.id,
                    v.revision,
                    v.driver_id,
                    v.vehicle_id,
                    v.scheduled_start,
                    v.shift_date,
                    veh.vehicle_gross_limits,
                    vt.ors_vehicle_type,
                    route.route_id,
                    route.solution_id
               FROM vrp_optimization v
               JOIN vehicles     veh ON veh.id = v.vehicle_id AND veh.is_deleted = false
               JOIN vehicle_type vt  ON vt.id  = veh.vehicle_type
               LEFT JOIN LATERAL (
                    -- A shift has one solution and one route in every path that
                    -- creates one; ORDER BY makes the degenerate case pick the
                    -- same one twice rather than at random.
                    SELECT r.id AS route_id, s.id AS solution_id
                      FROM vrp_solution s
                      JOIN vrp_route    r ON r.solution_id = s.id
                     WHERE s.optimization_id = v.id
                     ORDER BY r.id
                     LIMIT 1
               ) route ON true
              WHERE v.warehouse_id    = $1
                AND v.organisation_id = $2
                AND v.shift_date      = $3::date
                AND v.status          = 'planned'
                AND v.driver_id  IS NOT NULL
                AND v.vehicle_id IS NOT NULL
                AND (v.scheduled_start IS NULL
                     OR v.scheduled_start > now() + make_interval(secs => $4::int))
              ORDER BY v.created_at`,
            [warehouseId, organisationId, shiftDate, DISPATCH_LEAD_S],
        );

        if (shiftRows.length === 0) return [];

        const routeIds = shiftRows
            .map((r) => r.route_id)
            .filter((id): id is string => id !== null);

        const stopRows: StopRow[] = routeIds.length === 0 ? [] : await this.dataSource.query(
            `SELECT rs.route_id,
                    rs.step_index,
                    rs.package_id,
                    ST_X(rs.location) AS lon,
                    ST_Y(rs.location) AS lat,
                    pd.weight_kg,
                    pdw.scheduled_arrival,
                    p.eviction_count,
                    p.created_at,
                    latest.enums AS status
               FROM vrp_route_step rs
               JOIN packages p ON p.id = rs.package_id
               LEFT JOIN package_dimensions      pd  ON pd.package_id  = p.id
               LEFT JOIN package_delivery_window pdw ON pdw.package_id = p.id
               LEFT JOIN LATERAL (
                    SELECT ps.enums
                      FROM package_timeline pt
                      JOIN package_status  ps ON ps.id = pt.package_status
                     WHERE pt.package_id = p.id
                     ORDER BY pt.created_at DESC, pt.id DESC
                     LIMIT 1
               ) latest ON true
              WHERE rs.route_id = ANY($1::uuid[])
                AND rs.type = 'job'
                AND rs.package_id IS NOT NULL
              ORDER BY rs.route_id, rs.step_index`,
            [routeIds],
        );

        const stopsByRoute = new Map<string, RouteStop[]>();
        for (const row of stopRows) {
            const list = stopsByRoute.get(row.route_id) ?? [];
            list.push({
                packageId: row.package_id,
                lon: Number(row.lon),
                lat: Number(row.lat),
                weightG: this.weightGrams(row.weight_kg),
                deadlineMs: row.scheduled_arrival
                    ? new Date(row.scheduled_arrival).getTime()
                    : null,
                status: row.status ?? 'PENDING',
                evictionCount: Number(row.eviction_count ?? 0),
                createdAtMs: new Date(row.created_at).getTime(),
            });
            stopsByRoute.set(row.route_id, list);
        }

        const defaultDepartureMs = Math.max(
            now.getTime(),
            localHourMs(now, timezone, DEFAULT_DEPARTURE_HOUR),
        );

        return shiftRows.map((row) => ({
            shift: {
                id: row.id,
                revision: Number(row.revision),
                driverId: row.driver_id,
                vehicleId: row.vehicle_id,
                capacityG: this.capacityGrams(row.vehicle_gross_limits),
                departureMs: row.scheduled_start
                    ? new Date(row.scheduled_start).getTime()
                    : defaultDepartureMs,
                depot,
                stops: row.route_id ? (stopsByRoute.get(row.route_id) ?? []) : [],
            },
            profile: row.ors_vehicle_type ?? 'driving-car',
            routeId: row.route_id,
            solutionId: row.solution_id,
            shiftDate: row.shift_date,
            scheduledStart: row.scheduled_start,
        }));
    }

    /**
     * The one HTTP call Tier 1 is allowed, and only from Phase A.
     *
     * Returns null on any failure. A router that is down must degrade to the
     * haversine estimate, not to a failed package creation — the estimate is
     * already deliberately pessimistic, so falling back to it is safe in the
     * direction that matters.
     */
    private async measureLegs(
        candidate: Candidate,
        order: string[],
        pkg: IncomingPackage,
    ): Promise<Record<string, number> | null> {
        const byId = new Map(candidate.shift.stops.map((s) => [s.packageId, s]));
        const points: GeoPoint[] = [
            candidate.shift.depot,
            ...order.map((id) => {
                const stop = byId.get(id);
                return stop
                    ? { lon: stop.lon, lat: stop.lat }
                    : { lon: pkg.lon, lat: pkg.lat };
            }),
            candidate.shift.depot,
        ];

        try {
            const preview = await this.valhalla.route(
                candidate.profile,
                points.map((p) => [p.lon, p.lat] as [number, number]),
            );
            const measured: Record<string, number> = {};
            preview.legs.forEach((leg, i) => {
                const from = points[i];
                const to = points[i + 1];
                if (from && to) measured[legKey(from, to)] = leg.duration;
            });
            return measured;
        } catch (err: unknown) {
            this.logger.warn(
                `Grey-band routing call failed, keeping the estimate: ${String(err)}`,
            );
            return null;
        }
    }

    /**
     * Evicted packages get one immediate attempt to land somewhere else, usually
     * a neighbouring shift, so a bump is invisible to the customer. Eviction is
     * disabled for these — a victim must never displace a third package and
     * start a cascade. Anything that still does not fit stays PENDING for the
     * replan worker.
     */
    private async reassignVictims(
        organisationId: string,
        victimIds: string[],
    ): Promise<void> {
        for (const victimId of victimIds) {
            const outcome = await this.assign(organisationId, victimId, {
                allowEviction: false,
            });
            if (outcome.outcome === 'deferred' || outcome.outcome === 'skipped') {
                this.logger.log(
                    `Evicted package ${victimId} did not fit elsewhere; left PENDING.`,
                );
            }
        }
    }

    private async readRevision(
        runner: QueryRunner,
        shiftId: string,
    ): Promise<{ revision: number; status: string } | null> {
        const rows: { revision: number; status: string }[] = await runner.query(
            `SELECT revision, status FROM vrp_optimization WHERE id = $1 FOR UPDATE`,
            [shiftId],
        );
        return rows[0] ?? null;
    }

    // ── Conversions ──────────────────────────────────────────────────────────

    private toIncoming(row: PackageRow): IncomingPackage {
        return {
            id: row.id,
            lon: Number(row.lon),
            lat: Number(row.lat),
            weightG: this.weightGrams(row.weight_kg),
            deadlineMs: row.scheduled_arrival
                ? new Date(row.scheduled_arrival).getTime()
                : null,
            createdAtMs: new Date(row.created_at).getTime(),
            evictionCount: Number(row.eviction_count ?? 0),
        };
    }

    /**
     * Grams, not kilograms.
     *
     * The existing optimiser compares `capacity: [vehicle_gross_limits]` in kg
     * against `amount: [weight_kg * 1000]` in grams, so a 1000 kg van advertises
     * 1 kg of capacity and VROOM drops almost everything. Converting the capacity
     * up is the right direction — rounding the weights down to kg would lose
     * every sub-kilo parcel.
     */
    private capacityGrams(grossLimits: string | number | null): number {
        const kg = typeof grossLimits === 'string' ? Number(grossLimits) : grossLimits;
        return (Number.isFinite(kg) && kg ? Number(kg) : 1000) * 1000;
    }

    /** numeric columns come back from pg as strings. */
    private weightGrams(weightKg: string | number | null): number {
        const kg = typeof weightKg === 'string' ? Number(weightKg) : weightKg;
        return Number.isFinite(kg) && kg ? Math.round(Number(kg) * 1000) : 1;
    }

    private isAllowanceError(err: unknown): boolean {
        return (err as { code?: string })?.code === '23514';
    }

    private isUniqueViolation(err: unknown): boolean {
        return (err as { code?: string })?.code === '23505';
    }

    private reasonFor(err: unknown): string {
        if (this.isAllowanceError(err)) return 'shift_allowance_exhausted';
        return 'no_capacity';
    }
}
