import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsISO8601,
    IsUUID,
} from 'class-validator';

/**
 * Body for the synchronous mobile-app optimisation endpoint
 * (POST /api/v1/optimisation/adhoc). A single vehicle starts at a warehouse,
 * visits an explicit list of customers, and the optimal ordering is solved by
 * VROOM (which routes via Valhalla).
 */
export class AdhocOptimisationDto {
    @ApiProperty({ format: 'uuid', description: 'vehicle_type.id — resolves the routing profile.' })
    @IsUUID()
    vehicleType: string;

    @ApiProperty({ description: 'ISO-8601 timestamp the vehicle sets off.' })
    @IsISO8601()
    startDateTime: string;

    @ApiProperty({ format: 'uuid', description: 'warehouse.id — the start/end location.' })
    @IsUUID()
    startingLocationId: string;

    @ApiProperty({
        type: [String],
        format: 'uuid',
        description: 'Customer ids to visit (customer.id).',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(1000)
    @IsUUID('all', { each: true })
    customers: string[];
}
