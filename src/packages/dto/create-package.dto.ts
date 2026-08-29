import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsISO8601,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    IsUUID,
    MaxLength,
    ValidateNested,
} from 'class-validator';

/**
 * Physical package_dimensions. Every field is required because the table
 * declares all four NOT NULL, and weight is the capacity signal the assignment
 * engine matches against vehicles.vehicle_gross_limits.
 */
export class PackageDimensionsDto {
    @ApiProperty({ description: 'Weight in kilograms.', example: 2.5 })
    @IsNumber()
    @IsPositive()
    weightKg: number;

    @ApiProperty({ description: 'Length in centimetres.', example: 30 })
    @IsNumber()
    @IsPositive()
    lengthCm: number;

    @ApiProperty({ description: 'Width in centimetres.', example: 20 })
    @IsNumber()
    @IsPositive()
    widthCm: number;

    @ApiProperty({ description: 'Height in centimetres.', example: 15 })
    @IsNumber()
    @IsPositive()
    heightCm: number;
}

/**
 * Body for POST /api/v1/packages.
 *
 * Creating a package and assigning it to a shift are deliberately separate
 * transactions: the package is committed first, then assignment runs. An
 * assignment failure is reported in the response body, never as a non-2xx —
 * a package is never lost because no van had room for it.
 */
export class CreatePackageDto {
    @ApiPropertyOptional({
        format: 'uuid',
        description:
            'Client-supplied packages.id. Both clients mint a UUID before the ' +
            'call so they can name the storage path for photos; supplying it ' +
            'here keeps that working and makes the create idempotent on replay. ' +
            'Omitted, the server generates one.',
    })
    @IsOptional()
    @IsUUID()
    id?: string;

    @ApiProperty({
        format: 'uuid',
        description:
            'warehouse.id the package is dispatched from. Must belong to the ' +
            'active organisation.',
    })
    @IsUUID()
    warehouseId: string;

    @ApiProperty({ format: 'uuid', description: 'customer.id of the sender.' })
    @IsUUID()
    fromCustomerId: string;

    @ApiProperty({
        format: 'uuid',
        description:
            'customer.id of the recipient. Its customer_location is the routed ' +
            'stop; a recipient with no geocode cannot be assigned.',
    })
    @IsUUID()
    toCustomerId: string;

    @ApiPropertyOptional({
        description:
            'Human-facing tracking number. Omitted, the packages_set_tracking_number ' +
            'trigger generates one. Re-sending an existing number with an identical ' +
            'payload replays the original package instead of creating a second.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    trackingNumber?: string;

    @ApiPropertyOptional({ description: 'Free-text notes for the driver.' })
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    deliveryNotes?: string;

    @ApiProperty({ type: PackageDimensionsDto })
    @ValidateNested()
    @Type(() => PackageDimensionsDto)
    dimensions: PackageDimensionsDto;

    @ApiPropertyOptional({
        format: 'date-time',
        description:
            'Hard deadline — the promise made to the customer, stored in ' +
            'package_delivery_window.scheduled_arrival and never overwritten by ' +
            'the planner. Packages WITHOUT a deadline are the ones eligible to be ' +
            'bumped off a shift to make room for one that has a deadline.',
    })
    @IsOptional()
    @IsISO8601()
    deadlineAt?: string;

    @ApiPropertyOptional({
        default: true,
        description:
            'Run assignment immediately after creation. The mobile create-shift ' +
            'wizard MUST send false: it creates packages then hands their ids to ' +
            'POST /api/v1/optimisation/adhoc, which rejects a package that already ' +
            'belongs to an optimisation.',
    })
    @IsOptional()
    @IsBoolean()
    autoAssign?: boolean;
}

/**
 * Body for POST /api/v1/packages/bulk.
 *
 * This exists because assignment serialises on a per-warehouse advisory lock.
 * N individual creates take the lock N times; one bulk call takes it once,
 * runs the insertion loop in memory, writes once, and emits a single replan
 * notification for the whole batch.
 */
export class BulkCreatePackagesDto {
    @ApiProperty({ type: [CreatePackageDto], maxItems: 500 })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @ValidateNested({ each: true })
    @Type(() => CreatePackageDto)
    packages: CreatePackageDto[];
}
