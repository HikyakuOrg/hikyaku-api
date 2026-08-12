import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class DeactivateUsersDto {
    @ApiProperty({
        type: [String],
        format: 'uuid',
        minItems: 1,
        description:
            'Users to deactivate. Each is processed independently — see the ' +
            'response’s `failed` array rather than assuming all-or-nothing. The ' +
            'caller cannot deactivate themselves, and accounts holding every ' +
            'permission are refused.',
    })
    @IsArray()
    @ArrayNotEmpty()
    @IsUUID('4', { each: true })
    user_ids: string[];
}
