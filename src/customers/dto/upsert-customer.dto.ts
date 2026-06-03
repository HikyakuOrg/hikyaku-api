import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsEmail,
    IsNotEmpty,
    IsNumber,
    IsObject,
    IsOptional,
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

    @ApiPropertyOptional()
    @IsOptional()
    @IsEmail()
    email?: string;

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

    // ── Optional Pelias provenance ────────────────────────────────────────────
    @ApiPropertyOptional({ description: 'Pelias geocode confidence (0–1)' })
    @IsOptional()
    @IsNumber()
    confidence?: number;

    @ApiPropertyOptional({ description: 'Pelias global id for stable re-lookup' })
    @IsOptional()
    @IsString()
    peliasGid?: string;

    @ApiPropertyOptional({ description: 'Raw Pelias feature (stored as jsonb)' })
    @IsOptional()
    @IsObject()
    peliasRaw?: Record<string, unknown>;
}
