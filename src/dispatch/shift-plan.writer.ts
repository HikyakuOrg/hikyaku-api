import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

/** One job stop in the order it will be driven. */
export interface PlanStop {
    packageId: string;
    lon: number;
    lat: number;
    /** Planner ETA, epoch ms. */
    arrivalMs: number;
    /** Grams. Stored on the step as `load` so the dashboard can show it. */
    weightG: number;
}

export interface PlanWrite {
    optimisationId: string;
    routeId: string;
    solutionId: string;
    depot: { lon: number; lat: number };
    /** Epoch ms the van sets off. Step arrivals are stored relative to this. */
    departureMs: number;
    driverId: string;
    vehicleId: string;
    stops: PlanStop[];
    /** Why the plan changed; recorded on the revision snapshot. */
    reason: string;
}

/**
 * Every write that changes a shift's plan.
 *
 * Shared by Tier 1 (AssignmentService) and Tier 2 (ReplanWorker) so there is one
 * implementation of "this is what a shift's route looks like now", rather than
 * the three that exist today — insertOptimisedRoutes, insertAdhocRoutes, and the
 * web dashboard's hand-rolled step writes.
 *
 * Two rules are load-bearing:
 *
 *   NEVER INSERT vrp_optimization. Every insert fires enforce_shift_allowance()
 *   and bills a shift against the organisation's monthly allowance. A replan
 *   must be free forever, so this class only ever UPDATEs. Opening a shift is a
 *   deliberate, separate act — see AssignmentService.openShift and
 *   ShiftsService.create.
 *
 *   NEVER RENUMBER. A replan deletes every step on the route and re-inserts the
 *   ordered list. At ≤45 steps that is cheaper than the two-phase
 *   negate-then-renumber both clients hand-roll today, it is idempotent, and it
 *   keeps vrp_route_step_package_id_key UNIQUE(package_id) intact.
 */
@Injectable()
export class ShiftPlanWriter {
    private readonly logger = new Logger(ShiftPlanWriter.name);

    /**
     * The shift's solution and route, creating the empty pair when the shift has
     * none yet. A shift opened with no packages still needs a route for the
     * first assignment to have somewhere to write steps.
     */
    async ensureRoute(
        runner: QueryRunner,
        optimisationId: string,
    ): Promise<{ routeId: string; solutionId: string }> {
        const existing: { route_id: string; solution_id: string }[] = await runner.query(
            `SELECT r.id AS route_id, s.id AS solution_id
               FROM vrp_solution s
               JOIN vrp_route  r ON r.solution_id = s.id
              WHERE s.optimization_id = $1
              ORDER BY r.id
              LIMIT 1`,
            [optimisationId],
        );
        if (existing[0]) {
            return { routeId: existing[0].route_id, solutionId: existing[0].solution_id };
        }

        const solutionRows: { id: string }[] = await runner.query(
            `INSERT INTO vrp_solution (optimization_id, routes_count, unassigned_count)
             VALUES ($1, 1, 0)
             RETURNING id`,
            [optimisationId],
        );
        const solutionId = solutionRows[0].id;

        const routeRows: { id: string }[] = await runner.query(
            `INSERT INTO vrp_route (solution_id) VALUES ($1) RETURNING id`,
            [solutionId],
        );
        return { routeId: routeRows[0].id, solutionId };
    }

    /**
     * Copies the plan as it stands into vrp_optimization_revision before it is
     * overwritten. Called with the revision the snapshot represents — the one
     * about to be superseded, not the one replacing it.
     */
    async snapshotRevision(
        runner: QueryRunner,
        optimisationId: string,
        revision: number,
        reason: string,
    ): Promise<void> {
        await runner.query(
            `INSERT INTO vrp_optimization_revision
                 (optimisation_id, revision, reason, steps)
             SELECT $1, $2, $3,
                    COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'step_index', rs.step_index,
                                'type',       rs.type,
                                'package_id', rs.package_id,
                                'arrival',    rs.arrival
                            )
                            ORDER BY rs.step_index
                        ) FILTER (WHERE rs.id IS NOT NULL),
                        '[]'::jsonb
                    )
               FROM vrp_solution s
               JOIN vrp_route    r  ON r.solution_id = s.id
               LEFT JOIN vrp_route_step rs ON rs.route_id = r.id
              WHERE s.optimization_id = $1`,
            [optimisationId, revision, reason],
        );
    }

    /**
     * Rewrites the whole route: assignments, steps and ETAs.
     *
     * The order is forced by the foreign keys. vrp_route_step.package_id
     * references package_assignment(package_id), so assignments must exist before
     * the steps that point at them — and the old steps must be gone before an
     * assignment can be dropped.
     */
    async writePlan(runner: QueryRunner, plan: PlanWrite): Promise<void> {
        await runner.query(`DELETE FROM vrp_route_step WHERE route_id = $1`, [
            plan.routeId,
        ]);

        if (plan.stops.length > 0) {
            await this.upsertAssignments(runner, plan);
        }

        await this.insertSteps(runner, plan);

        if (plan.stops.length > 0) {
            await this.writeEtas(runner, plan.stops);
        }

        // Bumps revision and updated_at through the vrp_optimization_touch
        // trigger, which is what the clients' version poll watches. The response
        // blob doubles as the current plan, so a shift row alone still says what
        // the route is.
        await runner.query(
            `UPDATE vrp_optimization
                SET response = $2::jsonb
              WHERE id = $1`,
            [
                plan.optimisationId,
                JSON.stringify({
                    _plan: {
                        reason: plan.reason,
                        departure: new Date(plan.departureMs).toISOString(),
                        stops: plan.stops.map((s, i) => ({
                            index: i,
                            packageId: s.packageId,
                            eta: new Date(s.arrivalMs).toISOString(),
                        })),
                    },
                }),
            ],
        );
    }

    /**
     * Takes packages off a shift.
     *
     * Deleting package_assignment cascades the route step, which is why this is
     * one statement rather than three. `incrementEviction` separates a package
     * bumped to make room (which must be counted, or the eviction cap means
     * nothing) from one a dispatcher moved by hand (which must not be).
     */
    async detach(
        runner: QueryRunner,
        packageIds: string[],
        opts: { incrementEviction: boolean },
    ): Promise<void> {
        if (packageIds.length === 0) return;

        await runner.query(
            `DELETE FROM package_assignment WHERE package_id = ANY($1::uuid[])`,
            [packageIds],
        );

        await runner.query(
            `UPDATE packages
                SET optimisation_id = NULL,
                    eviction_count  = eviction_count + $2::int
              WHERE id = ANY($1::uuid[])`,
            [packageIds, opts.incrementEviction ? 1 : 0],
        );

        // Back to PENDING so the next assignment pass, or the nightly solve,
        // picks them up. This is the write that silently did nothing before
        // AllowStatusRevisits dropped the (package_id, package_status) unique
        // constraint — a removed package read ASSIGNED forever.
        await this.setStatus(runner, packageIds, 'PENDING');
    }

    /**
     * Stamps packages as belonging to this shift.
     *
     * The `optimisation_id IS NULL` guard is the point of truth, not the
     * caller's earlier read: if a concurrent request claimed one in between,
     * fewer rows come back and the whole transaction is rolled back rather than
     * writing a plan for a package somebody else owns.
     */
    async claimPackages(
        runner: QueryRunner,
        optimisationId: string,
        packageIds: string[],
    ): Promise<void> {
        if (packageIds.length === 0) return;

        const result = await runner.query(
            `UPDATE packages
                SET optimisation_id = $1
              WHERE id = ANY($2::uuid[])
                AND (optimisation_id IS NULL OR optimisation_id = $1)
            RETURNING id`,
            [optimisationId, packageIds],
            true,
        );
        const claimed = (result.records ?? []) as { id: string }[];

        if (claimed.length < packageIds.length) {
            const lost = packageIds.filter((id) => !claimed.some((c) => c.id === id));
            throw new ConflictException(
                `Package(s) claimed by another shift while this assignment was being planned: ${lost.join(', ')}`,
            );
        }

        await this.setStatus(runner, packageIds, 'ASSIGNED');
    }

    /**
     * Appends a package_timeline row per package, via insert_package_timeline()
     * so the latest-status guard is applied in exactly one place.
     */
    async setStatus(
        runner: QueryRunner,
        packageIds: string[],
        statusEnum: string,
    ): Promise<void> {
        if (packageIds.length === 0) return;
        await runner.query(
            `SELECT insert_package_timeline(id, $2::text)
               FROM unnest($1::uuid[]) AS id`,
            [packageIds, statusEnum],
        );
    }

    private async upsertAssignments(
        runner: QueryRunner,
        plan: PlanWrite,
    ): Promise<void> {
        const values = plan.stops
            .map((_, i) => `($${i + 1}, $${plan.stops.length + 1}, $${plan.stops.length + 2})`)
            .join(', ');

        await runner.query(
            `INSERT INTO package_assignment (package_id, driver_id, vehicle_id)
             VALUES ${values}
             ON CONFLICT (package_id)
             DO UPDATE SET driver_id  = EXCLUDED.driver_id,
                           vehicle_id = EXCLUDED.vehicle_id`,
            [...plan.stops.map((s) => s.packageId), plan.driverId, plan.vehicleId],
        );
    }

    /**
     * Writes the depot start step, one step per stop, and the depot end step.
     *
     * Arrivals are stored as seconds relative to departure, which is the
     * convention every other writer and both clients already read.
     */
    private async insertSteps(runner: QueryRunner, plan: PlanWrite): Promise<void> {
        const rows: {
            index: number;
            type: string;
            packageId: string | null;
            lon: number;
            lat: number;
            arrival: number;
            load: number[] | null;
        }[] = [];

        let cumulativeLoad = 0;
        rows.push({
            index: 0,
            type: 'start',
            packageId: null,
            lon: plan.depot.lon,
            lat: plan.depot.lat,
            arrival: 0,
            load: [0],
        });

        plan.stops.forEach((stop, i) => {
            cumulativeLoad += stop.weightG;
            rows.push({
                index: i + 1,
                type: 'job',
                packageId: stop.packageId,
                lon: stop.lon,
                lat: stop.lat,
                arrival: Math.max(0, Math.round((stop.arrivalMs - plan.departureMs) / 1000)),
                load: [cumulativeLoad],
            });
        });

        const lastArrival = plan.stops.length > 0
            ? Math.max(0, Math.round((plan.stops[plan.stops.length - 1].arrivalMs - plan.departureMs) / 1000))
            : 0;
        rows.push({
            index: plan.stops.length + 1,
            type: 'end',
            packageId: null,
            lon: plan.depot.lon,
            lat: plan.depot.lat,
            arrival: lastArrival,
            load: [cumulativeLoad],
        });

        const PARAMS_PER_ROW = 8;
        const placeholders = rows
            .map((_, i) => {
                const b = i * PARAMS_PER_ROW;
                return (
                    `($${b + 1},$${b + 2},$${b + 3},$${b + 4},` +
                    `ST_SetSRID(ST_Point($${b + 5},$${b + 6}),4326),` +
                    `$${b + 7},$${b + 8})`
                );
            })
            .join(', ');

        const params = rows.flatMap((r) => [
            plan.routeId,
            r.index,
            r.type,
            plan.solutionId,
            r.lon,
            r.lat,
            r.arrival,
            r.load,
        ]);

        // package_id is set in a second pass rather than inline: the job rows and
        // the depot rows would otherwise need different placeholder shapes.
        await runner.query(
            `INSERT INTO vrp_route_step
                 (route_id, step_index, type, solution_id, location, arrival, load)
             VALUES ${placeholders}`,
            params,
        );

        if (plan.stops.length > 0) {
            const updates = plan.stops
                .map((_, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::uuid)`)
                .join(', ');
            await runner.query(
                `UPDATE vrp_route_step rs
                    SET package_id = v.package_id
                   FROM (VALUES ${updates}) AS v(step_index, package_id)
                  WHERE rs.route_id = $1 AND rs.step_index = v.step_index`,
                [
                    plan.routeId,
                    ...plan.stops.flatMap((s, i) => [i + 1, s.packageId]),
                ],
            );
        }
    }

    /**
     * Writes package_delivery_window.estimated_arrival for the whole route.
     *
     * estimated_arrival, never scheduled_arrival: the latter is the promise made
     * to the customer and writing planner output there is what destroyed
     * deadlines before SplitDeadlineFromEta.
     */
    private async writeEtas(runner: QueryRunner, stops: PlanStop[]): Promise<void> {
        const values = stops
            .map((_, i) => `($${i * 2 + 1}::uuid, $${i * 2 + 2}::timestamptz)`)
            .join(', ');
        const params = stops.flatMap((s) => [
            s.packageId,
            new Date(s.arrivalMs).toISOString(),
        ]);

        await runner.query(
            `INSERT INTO package_delivery_window (package_id, estimated_arrival)
             VALUES ${values}
             ON CONFLICT (package_id)
             DO UPDATE SET estimated_arrival = EXCLUDED.estimated_arrival`,
            params,
        );

        this.logger.debug(`Rewrote ${stops.length} ETA(s).`);
    }
}
