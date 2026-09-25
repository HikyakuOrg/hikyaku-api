import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response schemas for the shift endpoints. */

/**
 * This shift driver's effective driving limits, resolved as the
 * driver's own profile, then the org default, dimension by dimension.
 * Resolved whether or not DRIVING_LIMITS is on, so every field null means
 * nobody has set a limit on any dimension (or the shift has no driver).
 * Whether automatic assignment applied them is `ShiftDto.drivingLimitsEnabled`.
 * Seconds and metres throughout; kilometres are a display concern only.
 */
export class DrivingLimitsDto {
    @ApiProperty({ type: Number, nullable: true })
    maxWorkingSeconds: number | null;

    @ApiProperty({ type: Number, nullable: true })
    maxDrivingSeconds: number | null;

    @ApiProperty({ type: Number, nullable: true })
    maxDistanceM: number | null;

    @ApiProperty({ type: Number, nullable: true })
    maxStops: number | null;
}

/** A shift — one `vrp_optimization` row plus its resolved plan. */
export class ShiftDto {
    @ApiProperty({ format: 'uuid', description: 'vrp_optimization.id.' })
    id: string;

    @ApiProperty({
        enum: ['planned', 'dispatched', 'completed', 'cancelled'],
        description:
            '`planned` is the only state open to automatic assignment, and only ' +
            'until 15 minutes before scheduledStart.',
    })
    status: 'planned' | 'dispatched' | 'completed' | 'cancelled';

    @ApiProperty({ format: 'uuid' })
    organisationId: string;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    warehouseId: string | null;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    driverId: string | null;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    vehicleId: string | null;

    @ApiProperty({ format: 'date' })
    shiftDate: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    scheduledStart: string | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'vrp_route.id of the single route, or null while the shift is empty.',
    })
    routeId: string | null;

    @ApiProperty({
        description: 'Job steps on the route, excluding depot start/end.',
    })
    stopCount: number;

    @ApiProperty({ description: 'Bumped on every plan rewrite.' })
    revision: number;

    @ApiProperty({ format: 'date-time' })
    updatedAt: string;

    @ApiProperty({ type: DrivingLimitsDto })
    drivingLimits: DrivingLimitsDto;

    @ApiProperty({
        description:
            'Whether DRIVING_LIMITS is on for this process, i.e. whether ' +
            'automatic assignment applies `drivingLimits` when planning. The ' +
            'limits are resolved and returned either way, so a client can ' +
            'show a configured limit as "not applied yet" while this is false.',
    })
    drivingLimitsEnabled: boolean;
}

/**
 * 200 body of GET /api/v1/shifts/{id}/version — the cheap poll the driver app
 * runs while a shift screen is in the foreground, so a package added to a
 * planned shift surfaces without a full reload.
 */
export class ShiftVersionDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({
        description: 'Compare against the loaded value; differs means replan.',
    })
    revision: number;

    @ApiProperty({ format: 'date-time' })
    updatedAt: string;

    @ApiProperty()
    stopCount: number;

    @ApiProperty({ enum: ['planned', 'dispatched', 'completed', 'cancelled'] })
    status: 'planned' | 'dispatched' | 'completed' | 'cancelled';
}

/** One package's feasibility verdict after a dispatcher override. */
export class ShiftPackageOutcomeDto {
    @ApiProperty({ format: 'uuid' })
    packageId: string;

    @ApiProperty({
        description: 'False when the package was already claimed elsewhere.',
    })
    added: boolean;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description:
            'Set when the package was added but breaks something — e.g. its own ' +
            'deadline, or another stop\u2019s. The dispatcher decided; we record it.',
    })
    warning: string | null;
}

/** 200 body of the shift-package mutation endpoints. */
export class ShiftPlanDto {
    @ApiProperty({ type: ShiftDto })
    shift: ShiftDto;

    @ApiProperty({ type: [ShiftPackageOutcomeDto] })
    packages: ShiftPackageOutcomeDto[];
}
