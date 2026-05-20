import {
    ArrayUnique,
    IsArray,
    IsEmail,
    IsNotEmpty,
    IsString,
    IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateInvitationDto {
    @ApiProperty()
    @IsEmail()
    @IsNotEmpty()
    user_email: string;

    @ApiProperty({ description: 'Must match the X-Organisation-Slug org id' })
    @IsUUID('4')
    org_id: string;

    @ApiProperty({ description: 'Role name, must match an existing app_roles.name' })
    @IsString()
    @IsNotEmpty()
    role: string;

    @ApiProperty({ type: [String], description: 'Array of app_permission.permission strings' })
    @IsArray()
    @ArrayUnique()
    @IsString({ each: true })
    permissions: string[];
}
