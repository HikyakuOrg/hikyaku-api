import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class UpdateUserRoleDto {
    @ApiProperty({
        format: 'uuid',
        description:
            'The team member whose role changes. Must already belong to the ' +
            'organisation resolved from `X-Organisation-Slug`.',
    })
    @IsUUID('4')
    user_id: string;

    @ApiProperty({
        description:
            'Role name, must match an existing app_roles.name — e.g. `Driver`. ' +
            'An unknown name is rejected with 400.',
        example: 'Driver',
    })
    @IsString()
    role_name: string;
}
