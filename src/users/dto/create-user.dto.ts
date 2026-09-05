import {
    IsArray,
    IsBoolean,
    IsEmail,
    IsNotEmpty,
    IsOptional,
    IsString,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DriverMetadataDto } from './driver-metadata.dto';

export class CreateUserDto {
    @ApiProperty()
    @IsEmail()
    @IsNotEmpty()
    user_email: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    user_display_name: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    user_phone_number: string;

    @ApiProperty({
        description: 'Role name, must match an existing app_roles.name',
    })
    @IsString()
    @IsNotEmpty()
    user_role: string;

    @ApiPropertyOptional({
        type: [String],
        description: 'Array of app_permission.permission strings',
    })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    user_permission?: string[];

    @ApiPropertyOptional({ description: 'Required when user_role is "Driver"' })
    @ValidateNested()
    @Type(() => DriverMetadataDto)
    @IsOptional()
    user_metadata?: DriverMetadataDto;

    @ApiPropertyOptional()
    @IsBoolean()
    @IsOptional()
    user_avatar?: boolean;
}
