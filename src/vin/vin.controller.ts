import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { AuthGuard } from '../auth/guards/auth.guard';
import { VinDecodeResultDto } from './dto/vin-decode-result.dto';
import { VinService } from './vin.service';
import { DecodeResult } from '@cardog/corgi';

@ApiTags('vin')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({
    description: 'Missing or invalid `Authorization` header.',
    type: ApiErrorDto,
})
@UseGuards(AuthGuard)
@Controller('api/v1/vin')
export class VinController {
    constructor(private readonly vinService: VinService) { }

    /**
     * Decode a VIN offline against corgi's bundled NHTSA vPIC snapshot.
     * Always 200s once authenticated — an invalid or unrecognised VIN comes
     * back as `valid: false` with `errors` explaining why, not a 4xx.
     */
    @Get(':vin')
    @ApiOperation({
        summary: 'Decode a VIN',
        description:
            'Looks up make, model, year, plant and engine data for a VIN. ' +
            'Runs entirely against a bundled offline database — no third-party ' +
            'call is made per request.',
    })
    @ApiParam({
        name: 'vin',
        description:
            '17-character Vehicle Identification Number. Case-insensitive.',
        example: 'KM8K2CAB4PU001140',
    })
    @ApiOkResponse({ type: VinDecodeResultDto })
    decode(@Param('vin') vin: string): Promise<DecodeResult> {
        return this.vinService.decode(vin);
    }
}
