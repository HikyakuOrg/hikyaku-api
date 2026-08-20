import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TZDATA_IMPORT_PHASES } from '../tzdata.constants';
import type { TzdataImportPhase } from '../tzdata.constants';

export class TzdataStatusDto {
    @ApiProperty({
        description:
            'Live check: whether tzdata.timezone currently has rows. Authoritative ' +
            'regardless of whether this instance ran the import itself.',
    })
    populated: boolean;

    @ApiProperty({
        enum: TZDATA_IMPORT_PHASES,
        description: 'What this instance has observed/done for the background boot-time import.',
    })
    importState: TzdataImportPhase;

    @ApiPropertyOptional({ description: 'Present only when importState is "failed".' })
    error?: string;

    @ApiProperty({ description: 'ISO timestamp of the last state transition on this instance.' })
    updatedAt: string;
}
