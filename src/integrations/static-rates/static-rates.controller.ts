import {
    BadRequestException,
    Controller,
    Get,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiProperty,
    ApiPropertyOptional,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import type { StaticRate, StaticRateKind, StaticRateUnit } from './band-plan';
import type { CoverageJson } from './coverage-export';
import { StaticRatesService, type StaticPlan } from './static-rates.service';

class StaticRateDto implements StaticRate {
    @ApiProperty({
        description:
            'Stable while the service and its bands are unchanged: ' +
            '`hikyaku:<service_id>`, `…:d:<min>-<max>` (distance, in `unit`) ' +
            'or `…:w:<min_grams>-<max_grams>` (weight).',
        example: 'hikyaku:prod_QhX1a2B3c4D5e6:d:5-10',
    })
    code: string;

    @ApiProperty()
    service_id: string;

    @ApiProperty()
    service_name: string;

    @ApiProperty({ type: String, nullable: true })
    description: string | null;

    @ApiProperty({ enum: ['flat', 'distance', 'weight'] })
    kind: StaticRateKind;

    @ApiProperty({
        description:
            'Decimal in the shop currency, priced at the upper band edge.',
        example: '15.00',
    })
    price: string;

    @ApiProperty({
        enum: ['km', 'mi', 'kg', 'lb'],
        nullable: true,
        description: 'The service unit; null for flat rates.',
    })
    unit: StaticRateUnit | null;

    @ApiProperty({ type: Number, nullable: true })
    band_min: number | null;

    @ApiProperty({ type: Number, nullable: true })
    band_max: number | null;

    @ApiPropertyOptional({ description: 'Distance bands only, in km.' })
    min_km?: number;

    @ApiPropertyOptional({ description: 'Distance bands only, in km.' })
    max_km?: number;

    @ApiPropertyOptional({ description: 'Weight bands only, in grams.' })
    min_grams?: number;

    @ApiPropertyOptional({ description: 'Weight bands only, in grams.' })
    max_grams?: number;
}

class StaticPlanDto implements StaticPlan {
    @ApiProperty({ example: 'AUD' })
    currency: string;

    @ApiProperty({
        type: [StaticRateDto],
        description: 'Empty while rates are off.',
    })
    rates: StaticRateDto[];

    @ApiProperty({
        type: 'object',
        additionalProperties: true,
        description:
            'Write verbatim to the Function metafield (at most 10 KB): ' +
            '`{ v: 1, w: [{ id, la, ln, e, p: [[lng,lat,…]], b: [[minLng,' +
            'minLat,maxLng,maxLat]] }] }`, one entry per mapped warehouse. ' +
            '`e`: covered everywhere (the floater rule, or matching off).',
    })
    coverage: CoverageJson;

    @ApiProperty({
        description:
            'Some areas are bounding boxes because the polygons did not fit, ' +
            'so checkout may offer rates slightly outside them.',
    })
    bbox_fallback: boolean;
}

class StaticPlanResponseDto {
    @ApiProperty({ type: StaticPlanDto })
    data: StaticPlanDto;
}

/** The static checkout path's rates and coverage for one shop. */
@ApiTags('integrations')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/integrations/shipping-rates/static-plan')
@UseGuards(PermissionGuard)
export class StaticRatesController {
    constructor(private readonly staticRates: StaticRatesService) {}

    @Get()
    @RequirePermission('warehouse.view')
    @ApiOperation({
        summary: "A shop's static rates and checkout coverage.",
        description:
            'For storefronts that cannot call the carrier callback. The ' +
            'connector writes `rates` into the delivery profiles and ' +
            '`coverage` into the Function metafield. Re-fetch on every push.',
    })
    @ApiQuery({ name: 'platform', example: 'shopify' })
    @ApiQuery({ name: 'shop_domain', example: 'store.myshopify.com' })
    @ApiOkResponse({ type: StaticPlanResponseDto })
    @ApiResponse({
        status: 404,
        description: 'No rate settings for this shop.',
        type: ApiErrorDto,
    })
    @ApiResponse({
        status: 409,
        description: 'The settings have no shop currency yet.',
        type: ApiErrorDto,
    })
    @ApiResponse({
        status: 422,
        description: 'Coverage cannot fit 10 KB, even as boxes.',
        type: ApiErrorDto,
    })
    async get(
        @Req() req: Request & { organisationId: string },
        @Query('platform') platform?: string,
        @Query('shop_domain') shopDomain?: string,
    ): Promise<StaticPlanResponseDto> {
        if (!platform || !/^[a-z0-9-]+$/.test(platform)) {
            throw new BadRequestException(
                'platform must be a lowercase slug (a-z, 0-9, -)',
            );
        }
        if (!shopDomain?.trim()) {
            throw new BadRequestException('shop_domain is required');
        }
        const data = await this.staticRates.plan(
            req.organisationId,
            platform,
            shopDomain,
        );
        return { data };
    }
}
