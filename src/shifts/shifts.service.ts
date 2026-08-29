import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AssignmentService } from 'src/dispatch/assignment.service';
import { ShiftPlanWriter } from 'src/dispatch/shift-plan.writer';
import type { AddPackagesToShiftDto, CreateShiftDto } from './dto/create-shift.dto';
import type { ShiftDto, ShiftPlanDto, ShiftVersionDto } from './dto/shift-result.dto';

interface ShiftRow {
    id: string;
    status: string;
    organisation_id: string | null;
    warehouse_id: string | null;
    driver_id: string | null;
    vehicle_id: string | null;
    shift_date: string;
    scheduled_start: string | null;
    route_id: string | null;
    stop_count: string | number;
    revision: number;
    updated_at: string;
}

/**
 * Shift lifecycle: open one, dispatch it, hand-edit its package set.
 *
 * This is the endpoint that replaces the web dashboard's seven direct
 * PostgREST writes (hikyaku/lib/actions/shift.ts). Three things come right at
 * once: the driver/vehicle/warehouse/date stop being a `request._meta` JSON blob
 * and become columns, the planner stops overwriting the customer's promised
 * arrival with a computed ETA, and the seven writes become one transaction.
 */
@Injectable()
export class ShiftsService {
    private readonly logger = new Logger(ShiftsService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly assignment: AssignmentService,
        private readonly planWriter: ShiftPlanWriter,
    ) { }

    /**
     * Opens an empty planned shift.
     *
     * The one place a human deliberately spends a shift from the organisation's
     * monthly allowance. Automatic assignment opens shifts too, but only when no
     * existing shift can take a package and a driver/vehicle pair is genuinely
     * idle — here, someone pressed a button.
     */
    async create(organisationId: string, dto: CreateShiftDto): Promise<ShiftDto> {
        const warehouse: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM warehouse WHERE id = $1 AND organisation_id = $2`,
            [dto.warehouseId, organisationId],
        );
        if (warehouse.length === 0) {
            // Cross-org rows read as unknown, never as "wrong organisation" —
            // same non-disclosure rule as OptimisationService.runAdhoc.
            throw new BadRequestException('Warehouse not found for this organisation.');
        }

        const driver: { warehouse_id: string | null }[] = await this.dataSource.query(
            `SELECT warehouse_id FROM drivers WHERE id = $1 AND organisation_id = $2`,
            [dto.driverId, organisationId],
        );
        if (driver.length === 0) {
            throw new BadRequestException('Driver not found for this organisation.');
        }

        const vehicle: { warehouse_id: string | null }[] = await this.dataSource.query(
            `SELECT warehouse_id FROM vehicles
              WHERE id = $1 AND organisation_id = $2 AND is_deleted = false`,
            [dto.vehicleId, organisationId],
        );
        if (vehicle.length === 0) {
            throw new BadRequestException('Vehicle not found for this organisation.');
        }

        // package_assignment carries an enforce_driver_vehicle_warehouse
        // constraint trigger; checking here turns a raw constraint error at the
        // first assignment into a clear 400 at shift creation.
        if (
            driver[0].warehouse_id !== dto.warehouseId ||
            vehicle[0].warehouse_id !== dto.warehouseId
        ) {
            throw new BadRequestException(
                'Driver and vehicle must both belong to the shift’s warehouse.',
            );
        }

        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            // Serialise against automatic assignment at the same depot, which is
            // also allowed to open shifts.
            await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
                `assign:${dto.warehouseId}`,
            ]);

            const clash: { id: string; driver_id: string; vehicle_id: string }[] =
                await runner.query(
                    `SELECT id, driver_id, vehicle_id
                       FROM vrp_optimization
                      WHERE shift_date = $1::date
                        AND status IN ('planned', 'dispatched')
                        AND (driver_id = $2 OR vehicle_id = $3)
                      LIMIT 1`,
                    [dto.shiftDate, dto.driverId, dto.vehicleId],
                );
            if (clash.length > 0) {
                const who =
                    clash[0].driver_id === dto.driverId ? 'driver' : 'vehicle';
                throw new ConflictException(
                    `That ${who} already has an open shift on ${dto.shiftDate}.`,
                );
            }

            let shiftId: string;
            try {
                const rows: { id: string }[] = await runner.query(
                    `INSERT INTO vrp_optimization
                         (provider, request, response, organisation_id,
                          status, driver_id, vehicle_id, warehouse_id,
                          shift_date, scheduled_start)
                     VALUES ('manual', $1::jsonb, '{}'::jsonb, $2,
                             'planned', $3, $4, $5, $6::date, $7::timestamptz)
                     RETURNING id`,
                    [
                        JSON.stringify({ _meta: { opened_by: 'shifts-api' } }),
                        organisationId,
                        dto.driverId,
                        dto.vehicleId,
                        dto.warehouseId,
                        dto.shiftDate,
                        dto.scheduledStart ?? null,
                    ],
                );
                shiftId = rows[0].id;
            } catch (err: unknown) {
                const code = (err as { code?: string })?.code;
                if (code === '23514') {
                    // enforce_shift_allowance(). 402 rather than 403: the caller
                    // has done nothing wrong, the organisation needs to pay.
                    throw new HttpException(
                        (err as { message?: string }).message ??
                        'You have used your free shifts for this billing period.',
                        HttpStatus.PAYMENT_REQUIRED,
                    );
                }
                if (code === '23505') {
                    // The partial unique index caught a race the SELECT above
                    // could not, because another writer committed in between.
                    throw new ConflictException(
                        `That driver or vehicle already has an open shift on ${dto.shiftDate}.`,
                    );
                }
                throw err;
            }

            // An empty shift still needs a route, so the first package to land on
            // it has somewhere to write steps.
            await this.planWriter.ensureRoute(runner, shiftId);
            await runner.commitTransaction();

            this.logger.log(
                `Opened shift ${shiftId} for driver ${dto.driverId} on ${dto.shiftDate}.`,
            );
            return this.get(organisationId, shiftId);
        } catch (err) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            throw err;
        } finally {
            await runner.release();
        }
    }

    /**
     * The cheap poll: one indexed row, no route, no packages.
     *
     * The driver app runs this while a shift screen is in the foreground and
     * reloads only when `revision` moves, so a package added to a planned shift
     * is never silently absent from the manifest.
     */
    async version(organisationId: string, id: string): Promise<ShiftVersionDto> {
        const shift = await this.load(organisationId, id);
        return {
            id: shift.id,
            revision: Number(shift.revision),
            updatedAt: new Date(shift.updated_at).toISOString(),
            stopCount: Number(shift.stop_count),
            status: shift.status as ShiftVersionDto['status'],
        };
    }

    async get(organisationId: string, id: string): Promise<ShiftDto> {
        return this.toDto(await this.load(organisationId, id));
    }

    /**
     * Closes a shift to automatic assignment.
     *
     * Idempotent from the driver app's point of view: the
     * dispatch_shift_on_in_transit trigger already flips a shift the moment any
     * package on it goes IN_TRANSIT, so this endpoint is for a dispatcher who
     * wants to close it early.
     */
    async dispatch(organisationId: string, id: string): Promise<ShiftDto> {
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            // FOR UPDATE so a concurrent dispatch, or the driver app's
            // IN_TRANSIT trigger, cannot both decide the shift was planned.
            const rows: { status: string }[] = await runner.query(
                `SELECT status FROM vrp_optimization
                  WHERE id = $1 AND organisation_id = $2
                  FOR UPDATE`,
                [id, organisationId],
            );
            if (rows.length === 0) throw new NotFoundException('Shift not found.');
            if (rows[0].status !== 'planned') {
                throw new ConflictException(
                    `Shift is ${rows[0].status}, so it cannot be dispatched.`,
                );
            }

            await runner.query(
                `UPDATE vrp_optimization
                    SET status = 'dispatched',
                        dispatched_at = COALESCE(dispatched_at, now())
                  WHERE id = $1`,
                [id],
            );
            await runner.commitTransaction();
        } catch (err) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            throw err;
        } finally {
            await runner.release();
        }

        return this.get(organisationId, id);
    }

    /** Dispatcher override: pin packages to this shift. */
    async addPackages(
        organisationId: string,
        id: string,
        dto: AddPackagesToShiftDto,
    ): Promise<ShiftPlanDto> {
        const { verdicts } = await this.assignment.assignToShift(
            organisationId,
            id,
            dto.packageIds,
        );
        return {
            shift: await this.get(organisationId, id),
            packages: verdicts.map((v) => ({
                packageId: v.packageId,
                added: v.added,
                warning: v.warning,
            })),
        };
    }

    /** Manual eviction. Refused once the package is loaded or moving. */
    async removePackage(
        organisationId: string,
        id: string,
        packageId: string,
    ): Promise<ShiftPlanDto> {
        await this.assignment.removeFromShift(organisationId, id, packageId);
        return {
            shift: await this.get(organisationId, id),
            packages: [{ packageId, added: false, warning: null }],
        };
    }

    private async load(organisationId: string, id: string): Promise<ShiftRow> {
        const rows: ShiftRow[] = await this.dataSource.query(
            `SELECT v.id,
                    v.status,
                    v.organisation_id,
                    v.warehouse_id,
                    v.driver_id,
                    v.vehicle_id,
                    v.shift_date,
                    v.scheduled_start,
                    v.revision,
                    v.updated_at,
                    route.route_id,
                    COALESCE(route.stop_count, 0) AS stop_count
               FROM vrp_optimization v
               LEFT JOIN LATERAL (
                    SELECT r.id AS route_id,
                           (SELECT count(*)
                              FROM vrp_route_step rs
                             WHERE rs.route_id = r.id AND rs.type = 'job') AS stop_count
                      FROM vrp_solution s
                      JOIN vrp_route    r ON r.solution_id = s.id
                     WHERE s.optimization_id = v.id
                     ORDER BY r.id
                     LIMIT 1
               ) route ON true
              WHERE v.id = $1 AND v.organisation_id = $2`,
            [id, organisationId],
        );
        const row = rows[0];
        if (!row) throw new NotFoundException('Shift not found.');
        return row;
    }

    private toDto(row: ShiftRow): ShiftDto {
        return {
            id: row.id,
            status: row.status as ShiftDto['status'],
            organisationId: row.organisation_id ?? '',
            warehouseId: row.warehouse_id,
            driverId: row.driver_id,
            vehicleId: row.vehicle_id,
            shiftDate: row.shift_date,
            scheduledStart: row.scheduled_start
                ? new Date(row.scheduled_start).toISOString()
                : null,
            routeId: row.route_id,
            stopCount: Number(row.stop_count),
            revision: Number(row.revision),
            updatedAt: new Date(row.updated_at).toISOString(),
        };
    }
}
