import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response schemas for the package endpoints.
 *
 * `type` is explicit on every nullable field: a bare `string | null` TS type
 * reflects as Object, which the Kotlin generator turns into an untyped `Any?`.
 */

/** A created package, as stored. */
export class PackageDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ format: 'date-time' })
    createdAt: string;

    @ApiProperty({ description: 'Generated or client-supplied tracking number.' })
    trackingNumber: string;

    @ApiProperty({ format: 'uuid' })
    organisationId: string;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    warehouseId: string | null;

    @ApiProperty({ format: 'uuid' })
    fromCustomerId: string;

    @ApiProperty({ format: 'uuid' })
    toCustomerId: string;

    @ApiProperty({ type: String, nullable: true })
    deliveryNotes: string | null;

    @ApiProperty({
        type: String,
        format: 'date-time',
        nullable: true,
        description:
            'The hard deadline (package_delivery_window.scheduled_arrival). Null ' +
            'means the package has no promise and may be bumped to make room.',
    })
    deadlineAt: string | null;

    @ApiProperty({
        description: 'Latest package_timeline status enum, e.g. PENDING, ASSIGNED.',
    })
    status: string;
}

/** The shift a package landed on. */
export class AssignedShiftDto {
    @ApiProperty({
        format: 'uuid',
        description: 'vrp_optimization.id — a shift is a vrp_optimization row.',
    })
    id: string;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    driverId: string | null;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    vehicleId: string | null;

    @ApiProperty({ format: 'date', description: 'Warehouse-local service day.' })
    shiftDate: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    scheduledStart: string | null;

    @ApiProperty({
        description:
            'Zero-based position of this package among the route job steps, ' +
            'excluding the depot start/end steps.',
    })
    stopIndex: number;

    @ApiProperty({
        type: String,
        format: 'date-time',
        nullable: true,
        description:
            'Planner ETA (package_delivery_window.estimated_arrival). Rewritten ' +
            'on every replan; never a deadline.',
    })
    estimatedArrival: string | null;

    @ApiProperty({
        description:
            'vrp_optimization.revision at the time of assignment. Clients compare ' +
            'this against GET /api/v1/shifts/{id}/version to detect a replan.',
    })
    revision: number;
}

/** What assignment did, or why it did nothing. */
export class AssignmentOutcomeDto {
    @ApiProperty({
        enum: ['assigned', 'assigned_new_shift', 'deferred', 'skipped'],
        description:
            '`assigned` — joined an existing planned shift. ' +
            '`assigned_new_shift` — a new shift was opened for it, which consumes ' +
            'one shift from the organisation allowance. ' +
            '`deferred` — created but not assigned; it will be picked up by the ' +
            'next replan or by a dispatcher. ' +
            '`skipped` — assignment was not attempted.',
    })
    outcome: 'assigned' | 'assigned_new_shift' | 'deferred' | 'skipped';

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        enum: [
            'no_capacity',
            'no_free_driver_vehicle',
            'shift_allowance_exhausted',
            'no_geocode',
            'auto_assign_disabled',
            'deadline_infeasible',
        ],
        description: 'Set for `deferred` and `skipped`; null otherwise.',
    })
    reason: string | null;

    @ApiPropertyOptional({
        type: AssignedShiftDto,
        nullable: true,
        description: 'Present for `assigned` and `assigned_new_shift`.',
    })
    shift: AssignedShiftDto | null;

    @ApiProperty({
        type: [String],
        format: 'uuid',
        description:
            'Packages bumped off a shift to make room for this one. Each was ' +
            're-assigned in the same request where possible; any that could not ' +
            'be are back at PENDING. Empty in the normal case.',
    })
    evictedPackageIds: string[];
}

/** 201 body of POST /api/v1/packages. */
export class CreatePackageResultDto {
    @ApiProperty({ type: PackageDto })
    package: PackageDto;

    @ApiProperty({ type: AssignmentOutcomeDto })
    assignment: AssignmentOutcomeDto;
}

/** One entry of the bulk response, index-aligned with the request array. */
export class BulkCreatePackageResultDto {
    @ApiProperty({ description: 'Index into the submitted packages array.' })
    index: number;

    @ApiPropertyOptional({
        type: CreatePackageResultDto,
        nullable: true,
        description: 'Present when this entry succeeded.',
    })
    result: CreatePackageResultDto | null;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description:
            'Failure detail for this entry. One bad entry does not fail the batch.',
    })
    error: string | null;
}

/** 201 body of POST /api/v1/packages/bulk. */
export class BulkCreatePackagesResultDto {
    @ApiProperty({ type: [BulkCreatePackageResultDto] })
    results: BulkCreatePackageResultDto[];
}
