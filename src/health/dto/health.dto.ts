import { ApiProperty } from '@nestjs/swagger';

export class HealthDto {
    @ApiProperty({
        description: 'Always "ok" — the endpoint only reports process liveness.',
        example: 'ok',
    })
    status: 'ok';
}
