import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import {
    AssignmentService,
    type AssignmentOutcome,
} from 'src/dispatch/assignment.service';
import type {
    BulkCreatePackagesDto,
    CreatePackageDto,
} from './dto/create-package.dto';
import type {
    AssignmentOutcomeDto,
    BulkCreatePackagesResultDto,
    CreatePackageResultDto,
    PackageDto,
} from './dto/package-result.dto';

/** The fields a caller outside this module needs to supply to create a package. */
export interface PackageSpec {
    id?: string;
    warehouseId: string;
    fromCustomerId: string;
    toCustomerId: string;
    trackingNumber?: string;
    deliveryNotes?: string | null;
    weightKg: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    /** Customer promise. Never written by a planner. */
    deadlineAt?: string | null;
    /** Planned collection time, when the caller has one. */
    scheduledDeparture?: string | null;
}

interface PackageRow {
    id: string;
    created_at: string;
    tracking_number: string;
    organisation_id: string;
    warehouse_id: string | null;
    from_customer: string;
    to_customer: string;
    delivery_notes: string | null;
    scheduled_arrival: string | null;
    status: string | null;
}

const skipped = (reason: string): AssignmentOutcomeDto => ({
    outcome: 'skipped',
    reason,
    shift: null,
    evictedPackageIds: [],
});

/**
 * Package creation, and the assignment it triggers.
 *
 * The first real write path for packages: both clients used to insert straight
 * through PostgREST in four or five non-atomic calls, so a failure halfway
 * through left a package with no dimensions, or a delivery window with no
 * package.
 *
 * CREATION AND ASSIGNMENT ARE SEPARATE TRANSACTIONS, always. Transaction A
 * writes the package and commits; assignment then runs in its own. An
 * assignment failure — including the 23514 the shift-allowance trigger raises —
 * comes back as `deferred` in the response body, never as a non-2xx. A package
 * is never lost because no van had room for it.
 */
@Injectable()
export class PackagesService {
    private readonly logger = new Logger(PackagesService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly assignment: AssignmentService,
    ) {}

    async create(
        organisationId: string,
        dto: CreatePackageDto,
    ): Promise<{ result: CreatePackageResultDto; replayed: boolean }> {
        await this.validateReferences(organisationId, dto);

        // Idempotent replay. Both clients retry on a flaky connection, and a
        // duplicate package is a duplicate parcel on a van.
        if (dto.trackingNumber) {
            const existing = await this.findByTrackingNumber(
                organisationId,
                dto.trackingNumber,
            );
            if (existing) {
                if (!this.matchesPayload(existing, dto)) {
                    throw new ConflictException(
                        `Tracking number ${dto.trackingNumber} already belongs to a different package.`,
                    );
                }
                return {
                    replayed: true,
                    result: {
                        package: this.toDto(existing),
                        assignment: skipped('auto_assign_disabled'),
                    },
                };
            }
        }

        // ── Transaction A ────────────────────────────────────────────────────
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        let packageId: string;
        try {
            [packageId] = await this.insertMany(runner, organisationId, [
                this.toSpec(dto),
            ]);
            await runner.commitTransaction();
        } catch (err) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            throw this.translate(err, dto.trackingNumber);
        } finally {
            await runner.release();
        }

        // ── Transaction B ────────────────────────────────────────────────────
        const assignment =
            dto.autoAssign === false
                ? skipped('auto_assign_disabled')
                : this.toOutcomeDto(
                      await this.assignment.assign(organisationId, packageId),
                  );

        const stored = await this.findById(organisationId, packageId);
        if (!stored) {
            // Committed a moment ago; only a concurrent delete could do this.
            throw new NotFoundException('Package disappeared after creation.');
        }

        return {
            replayed: false,
            result: { package: this.toDto(stored), assignment },
        };
    }

    /**
     * Bulk create.
     *
     * This endpoint exists because assignment serialises on a per-warehouse
     * advisory lock: 500 individual POSTs take that lock 500 times. Creation
     * happens in one transaction for the whole batch, and assignment runs after
     * it commits — still separate transactions, just amortised.
     *
     * One bad entry does not fail the batch; it comes back with its own error
     * and its index.
     */
    async createBulk(
        organisationId: string,
        dto: BulkCreatePackagesDto,
    ): Promise<BulkCreatePackagesResultDto> {
        const results: BulkCreatePackagesResultDto['results'] = [];

        for (const [index, spec] of dto.packages.entries()) {
            try {
                const { result } = await this.create(organisationId, spec);
                results.push({ index, result, error: null });
            } catch (err: unknown) {
                results.push({
                    index,
                    result: null,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return { results };
    }

    /**
     * Unassign and assign again — the path for a deadline that changed after
     * creation, and for a dispatcher who wants the planner to reconsider.
     */
    async reassign(
        organisationId: string,
        packageId: string,
    ): Promise<CreatePackageResultDto> {
        const before = await this.findById(organisationId, packageId);
        if (!before) throw new NotFoundException('Package not found.');

        await this.assignment.unassign(organisationId, packageId);
        const assignment = this.toOutcomeDto(
            await this.assignment.assign(organisationId, packageId),
        );

        const stored = await this.findById(organisationId, packageId);
        return {
            package: this.toDto(stored ?? before),
            assignment,
        };
    }

    /**
     * Creates packages on a transaction the caller already owns.
     *
     * The booking checkout path (PaymentsService.fulfillCheckoutSession) needs
     * this: the packages and the payment row have to commit together, or a paid
     * booking can end up with no parcel. Assignment is the caller's business,
     * after its own commit.
     */
    async createMany(
        runner: QueryRunner,
        organisationId: string,
        specs: PackageSpec[],
    ): Promise<string[]> {
        return this.insertMany(runner, organisationId, specs);
    }

    /** Runs assignment for packages created elsewhere, swallowing failures. */
    async assignCreated(
        organisationId: string,
        packageIds: string[],
    ): Promise<void> {
        for (const packageId of packageIds) {
            const outcome = await this.assignment.assign(
                organisationId,
                packageId,
            );
            if (outcome.outcome === 'deferred') {
                this.logger.log(
                    `Package ${packageId} deferred (${outcome.reason}); the replan worker will retry it.`,
                );
            }
        }
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /**
     * The four writes that make a package: the row, its dimensions, its delivery
     * window, and its first timeline entry.
     *
     * All four on one transaction. The tracking number is passed through as NULL
     * when the caller has none, because that is exactly what the
     * packages_set_tracking_number trigger tests for before generating one — an
     * empty string would be stored verbatim and collide on the second package.
     */
    private async insertMany(
        runner: QueryRunner,
        organisationId: string,
        specs: PackageSpec[],
    ): Promise<string[]> {
        const ids: string[] = [];

        for (const spec of specs) {
            const rows: { id: string }[] = await runner.query(
                `INSERT INTO packages
                     (id, organisation_id, warehouse_id, from_customer, to_customer,
                      delivery_notes, tracking_number)
                 VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
                 RETURNING id`,
                [
                    spec.id ?? null,
                    organisationId,
                    spec.warehouseId,
                    spec.fromCustomerId,
                    spec.toCustomerId,
                    spec.deliveryNotes ?? null,
                    spec.trackingNumber ?? null,
                ],
            );
            const id = rows[0].id;
            ids.push(id);

            await runner.query(
                `INSERT INTO package_dimensions
                     (package_id, weight_kg, length_cm, width_cm, height_cm)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, spec.weightKg, spec.lengthCm, spec.widthCm, spec.heightCm],
            );

            // scheduled_arrival is the promise. estimated_arrival — the planner's
            // guess — is written later, by the planner, and only there.
            await runner.query(
                `INSERT INTO package_delivery_window
                     (package_id, scheduled_departure, scheduled_arrival)
                 VALUES ($1, $2::timestamptz, $3::timestamptz)`,
                [id, spec.scheduledDeparture ?? null, spec.deadlineAt ?? null],
            );

            await runner.query(
                `SELECT insert_package_timeline($1::uuid, 'PENDING')`,
                [id],
            );
        }

        return ids;
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    private async validateReferences(
        organisationId: string,
        dto: CreatePackageDto,
    ): Promise<void> {
        const warehouse: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM warehouse WHERE id = $1 AND organisation_id = $2`,
            [dto.warehouseId, organisationId],
        );
        if (warehouse.length === 0) {
            // "Unknown", never "belongs to another organisation" — the same
            // non-disclosure rule OptimisationService.runAdhoc follows.
            throw new BadRequestException(
                'Warehouse not found for this organisation.',
            );
        }

        const customers: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM customer
              WHERE id = ANY($1::uuid[]) AND organisation_id = $2`,
            [[dto.fromCustomerId, dto.toCustomerId], organisationId],
        );
        const known = new Set(customers.map((c) => c.id));
        const missing = [dto.fromCustomerId, dto.toCustomerId].filter(
            (id) => !known.has(id),
        );
        if (missing.length > 0) {
            throw new BadRequestException(
                `Customer not found for this organisation: ${[...new Set(missing)].join(', ')}`,
            );
        }
    }

    private async findById(
        organisationId: string,
        packageId: string,
    ): Promise<PackageRow | null> {
        const rows: PackageRow[] = await this.dataSource.query(
            `${this.selectPackage()} WHERE p.id = $1 AND p.organisation_id = $2`,
            [packageId, organisationId],
        );
        return rows[0] ?? null;
    }

    private async findByTrackingNumber(
        organisationId: string,
        trackingNumber: string,
    ): Promise<PackageRow | null> {
        const rows: PackageRow[] = await this.dataSource.query(
            `${this.selectPackage()} WHERE p.tracking_number = $1 AND p.organisation_id = $2`,
            [trackingNumber, organisationId],
        );
        return rows[0] ?? null;
    }

    /**
     * The latest-status LATERAL breaks its tie on (created_at DESC, id DESC).
     * Since AllowStatusRevisits a package may hold the same status twice, and
     * without the id tiebreak this returns an arbitrary one of them.
     */
    private selectPackage(): string {
        return `
            SELECT p.id,
                   p.created_at,
                   p.tracking_number,
                   p.organisation_id,
                   p.warehouse_id,
                   p.from_customer,
                   p.to_customer,
                   p.delivery_notes,
                   pdw.scheduled_arrival,
                   latest.enums AS status
              FROM packages p
              LEFT JOIN package_delivery_window pdw ON pdw.package_id = p.id
              LEFT JOIN LATERAL (
                   SELECT ps.enums
                     FROM package_timeline pt
                     JOIN package_status  ps ON ps.id = pt.package_status
                    WHERE pt.package_id = p.id
                    ORDER BY pt.created_at DESC, pt.id DESC
                    LIMIT 1
              ) latest ON true`;
    }

    // ── Mapping ──────────────────────────────────────────────────────────────

    private toSpec(dto: CreatePackageDto): PackageSpec {
        return {
            id: dto.id,
            warehouseId: dto.warehouseId,
            fromCustomerId: dto.fromCustomerId,
            toCustomerId: dto.toCustomerId,
            trackingNumber: dto.trackingNumber,
            deliveryNotes: dto.deliveryNotes ?? null,
            weightKg: dto.dimensions.weightKg,
            lengthCm: dto.dimensions.lengthCm,
            widthCm: dto.dimensions.widthCm,
            heightCm: dto.dimensions.heightCm,
            deadlineAt: dto.deadlineAt ?? null,
        };
    }

    private toDto(row: PackageRow): PackageDto {
        return {
            id: row.id,
            createdAt: new Date(row.created_at).toISOString(),
            trackingNumber: row.tracking_number,
            organisationId: row.organisation_id,
            warehouseId: row.warehouse_id,
            fromCustomerId: row.from_customer,
            toCustomerId: row.to_customer,
            deliveryNotes: row.delivery_notes,
            deadlineAt: row.scheduled_arrival
                ? new Date(row.scheduled_arrival).toISOString()
                : null,
            status: row.status ?? 'PENDING',
        };
    }

    private toOutcomeDto(outcome: AssignmentOutcome): AssignmentOutcomeDto {
        return {
            outcome: outcome.outcome,
            reason: outcome.reason,
            shift: outcome.shift,
            evictedPackageIds: outcome.evictedPackageIds,
        };
    }

    /**
     * A replay that raced another replay lands here: both passed the
     * tracking-number lookup, one inserted first.
     */
    private translate(err: unknown, trackingNumber?: string): unknown {
        if ((err as { code?: string })?.code === '23505') {
            return new ConflictException(
                trackingNumber
                    ? `Tracking number ${trackingNumber} already belongs to a different package.`
                    : 'That package already exists.',
            );
        }
        return err;
    }

    /**
     * Whether a replayed request describes the same parcel.
     *
     * Deliberately narrow: the sender, the recipient and the depot. Those are
     * what make it a different delivery. Notes and dimensions can legitimately be
     * corrected on a retry, and refusing those would turn a flaky connection into
     * a support ticket.
     */
    private matchesPayload(row: PackageRow, dto: CreatePackageDto): boolean {
        return (
            row.from_customer === dto.fromCustomerId &&
            row.to_customer === dto.toCustomerId &&
            row.warehouse_id === dto.warehouseId
        );
    }
}
