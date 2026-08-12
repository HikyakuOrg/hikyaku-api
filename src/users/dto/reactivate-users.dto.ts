import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class ReactivateUsersDto {
    @ApiProperty({
        type: [String],
        format: 'uuid',
        minItems: 1,
        description:
            'Users to lift the deactivation ban from. Each is processed ' +
            'independently — see the response’s `failed` array.',
    })
    @IsArray()
    @ArrayNotEmpty()
    @IsUUID('4', { each: true })
    user_ids: string[];
}
