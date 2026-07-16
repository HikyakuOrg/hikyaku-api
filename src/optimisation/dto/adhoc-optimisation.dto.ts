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
 * delivers an explicit list of already-created packages, and the optimal
 * ordering is solved by VROOM (which routes via Valhalla).
 *
 * Packages are created up-front by the mobile "create shift" wizard (picked from
 * the org's unassigned packages, or composed inline), so this endpoint only ever
 * receives existing packages.id values — it never creates packages itself.
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
        description:
            'Existing packages.id values to deliver on this shift. Each must sit at ' +
            'startingLocationId and not already belong to another optimisation.',
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(1000)
    @IsUUID('all', { each: true })
    packages: string[];
}
