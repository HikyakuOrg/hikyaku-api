import { ApiProperty } from '@nestjs/swagger';

/**
 * One warehouse of the organisation, as GET /api/v1/warehouses lists it: the
 * fields a connector needs to let a merchant pick where a storefront location
 * ships from.
 */
export class WarehouseDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'West Melbourne Depot' })
    name: string;

    @ApiProperty({ description: 'Street address line.' })
    address: string;

    @ApiProperty({ example: 'West Melbourne' })
    city: string;

    @ApiProperty({ example: 'VIC' })
    state: string;

    @ApiProperty({ example: '3003' })
    postcode: string;

    @ApiProperty({
        description:
            'Country as entered on the warehouse, a name such as "Australia" ' +
            'rather than an ISO code.',
        example: 'Australia',
    })
    country: string;

    @ApiProperty({
        description: 'IANA time zone of the warehouse.',
        example: 'Australia/Melbourne',
    })
    timezone: string;

    @ApiProperty({ minimum: -180, maximum: 180, example: 144.9407 })
    lon: number;

    @ApiProperty({ minimum: -90, maximum: 90, example: -37.8063 })
    lat: number;
}

export class WarehouseListDto {
    @ApiProperty({ type: [WarehouseDto] })
    data: WarehouseDto[];
}
