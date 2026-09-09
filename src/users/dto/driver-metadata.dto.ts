import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsBoolean,
    IsDateString,
    IsOptional,
    IsString,
    IsUUID,
} from 'class-validator';

export class DriverMetadataDto {
    @ApiPropertyOptional()
    @IsString()
    @IsOptional()
    driver_license?: string;

    @ApiPropertyOptional({
        description: 'ISO 8601 date string, e.g. 2028-06-30',
    })
    @IsDateString()
    @IsOptional()
    license_expiry?: string;

    @ApiPropertyOptional({
        description: 'UUID of the warehouse the driver belongs to',
    })
    @IsUUID()
    @IsOptional()
    warehouse_id?: string;

    @ApiPropertyOptional()
    @IsString()
    @IsOptional()
    country_of_issue?: string;

    @ApiPropertyOptional()
    @IsBoolean()
    @IsOptional()
    driver_under_probation?: boolean;

    @ApiPropertyOptional({
        description: 'UUID FK to vehicle_type.id (the driver license class)',
    })
    @IsUUID()
    @IsOptional()
    license_type?: string;
}
