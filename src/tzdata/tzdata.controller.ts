import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TzdataService } from './tzdata.service';
import { TzdataStatusDto } from './dto/tzdata-status.dto';

/**
 * Operational status only (no tenant data) — unauthenticated by design, same
 * reasoning as a health check, so ops/monitoring can poll it directly.
 */
@ApiTags('tzdata')
@Controller('api/v1/tzdata')
export class TzdataController {
    constructor(private readonly tzdataService: TzdataService) { }

    @Get('status')
    @ApiOperation({
        summary: 'Timezone boundary data import status.',
        description:
            'Reports whether tzdata.timezone is populated (a live check) and what ' +
            'this instance has observed/done for the background boot-time import ' +
            '— useful since the import runs in a worker thread and never blocks boot.',
    })
    @ApiOkResponse({ type: TzdataStatusDto })
    async status(): Promise<TzdataStatusDto> {
        const populated = await this.tzdataService.isPopulated();
        return { populated, ...this.tzdataService.getImportState() };
    }
}
