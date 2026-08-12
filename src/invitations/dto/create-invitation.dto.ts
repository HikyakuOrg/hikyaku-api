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

    @ApiProperty({
        format: 'uuid',
        description:
            'Id of the organisation to invite into. Must be the same organisation ' +
            'the `X-Organisation-Slug` header resolves to — a mismatch is ' +
            'rejected with 400. Redundant by design: it makes the caller state ' +
            'which tenant they believe they are acting on.',
    })
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
