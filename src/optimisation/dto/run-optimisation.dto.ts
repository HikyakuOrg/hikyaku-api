import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsISO8601,
    IsOptional,
    IsUUID,
    ValidateNested,
} from 'class-validator';

export class SetOffOverrideDto {
    @ApiProperty({ format: 'uuid' })
    @IsUUID()
    vehicleId: string;

    @ApiProperty({ description: 'ISO timestamp the vehicle should set off.' })
    @IsISO8601()
    setOffAt: string;
}

export class RunOptimisationDto {
    @ApiProperty({ format: 'uuid', description: 'Warehouse to optimise.' })
    @IsUUID()
    warehouseId: string;

    @ApiPropertyOptional({ type: [SetOffOverrideDto] })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SetOffOverrideDto)
    @ArrayMaxSize(1000)
    setOffOverrides?: SetOffOverrideDto[];
}
