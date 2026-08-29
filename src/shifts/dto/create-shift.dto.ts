import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsDateString,
    IsISO8601,
    IsOptional,
    IsUUID,
} from 'class-validator';

/**
 * Body for POST /api/v1/shifts — open an empty shift for a driver/vehicle pair
 * on a given service day.
 *
 * A shift is a `vrp_optimization` row, and inserting one fires
 * enforce_shift_allowance(): this endpoint is the one place a human deliberately
 * consumes a shift from the organisation's monthly allowance. Automatic
 * assignment opens shifts too, but only when no existing shift can take the
 * package and a driver/vehicle pair is genuinely idle.
 */
export class CreateShiftDto {
    @ApiProperty({
        format: 'uuid',
        description: 'warehouse.id the shift starts and ends at.',
    })
    @IsUUID()
    warehouseId: string;

    @ApiProperty({
        format: 'uuid',
        description: 'drivers.id. Must share a warehouse with vehicleId.',
    })
    @IsUUID()
    driverId: string;

    @ApiProperty({
        format: 'uuid',
        description:
            'vehicles.id. Also resolves the routing profile via vehicles.vehicle_type.',
    })
    @IsUUID()
    vehicleId: string;

    @ApiProperty({
        format: 'date',
        example: '2026-09-01',
        description:
            'Warehouse-local service day (YYYY-MM-DD). A driver or vehicle can ' +
            'hold at most one open shift per day.',
    })
    @IsDateString()
    shiftDate: string;

    @ApiPropertyOptional({
        format: 'date-time',
        description:
            'When the vehicle sets off. Omitted, the shift stays open to automatic ' +
            'assignment indefinitely; set, it closes 15 minutes before this time so ' +
            'nothing is added to a van about to roll.',
    })
    @IsOptional()
    @IsISO8601()
    scheduledStart?: string;
}

/** Body for POST /api/v1/shifts/{id}/packages — pin packages to a chosen shift. */
export class AddPackagesToShiftDto {
    @ApiProperty({
        type: [String],
        format: 'uuid',
        description:
            'Existing packages.id values. Candidate selection is bypassed, but ' +
            'feasibility still runs: a package that breaks a deadline is reported ' +
            'as a warning rather than refused.',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(500)
    @IsUUID('all', { each: true })
    packageIds: string[];
}
