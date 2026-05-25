import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const CARD_STATUSES = ['active', 'inactive', 'canceled'] as const;

export class SetCardStatusDto {
    @ApiProperty({
        enum: CARD_STATUSES,
        description: "'inactive' freezes the card; 'canceled' is permanent.",
    })
    @IsIn(CARD_STATUSES)
    status: (typeof CARD_STATUSES)[number];
}
