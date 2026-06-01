import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsNotEmpty,
    IsNumber,
    IsString,
    Max,
    Min,
    ValidateNested,
} from 'class-validator';

export class CustomerAddressDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    street: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    suburb: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    state: string;

    @ApiProperty()
    @IsString()
    postcode: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    country: string;
}

export class UpsertCustomerDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    phone: string;

    @ApiProperty({ type: () => CustomerAddressDto })
    @ValidateNested()
    @Type(() => CustomerAddressDto)
    address: CustomerAddressDto;

    @ApiProperty({ minimum: -90, maximum: 90 })
    @IsNumber()
    @Min(-90)
    @Max(90)
    lat: number;

    @ApiProperty({ minimum: -180, maximum: 180 })
    @IsNumber()
    @Min(-180)
    @Max(180)
    lon: number;
}
