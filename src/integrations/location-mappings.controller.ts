import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Put,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import {
    ApiGuardErrors,
    ApiNotFound,
} from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import type { AuthedUser } from 'src/auth/authed-user';
import {
    IntegrationLocationListDto,
    UpsertIntegrationLocationsDto,
} from './dto/integration-location.dto';
import { LocationMappingsService } from './location-mappings.service';

/**
 * Storefront locations and the warehouse each ships from. `platform` is a
 * data value, so all connectors share these routes.
 */
@ApiTags('integrations')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/integrations/locations')
@UseGuards(PermissionGuard)
export class LocationMappingsController {
    constructor(private readonly mappings: LocationMappingsService) {}

    // Same permission as GET /api/v1/warehouses: a mapping exposes its
    // warehouse.
    @Get()
    @RequirePermission('warehouse.view')
    @ApiOperation({
        summary: 'List storefront locations and where each ships from.',
        description:
            'Ordered by platform and shop, live locations first. Includes ' +
            'stale locations (`stale_at` set).',
    })
    @ApiQuery({ name: 'platform', required: false, example: 'shopify' })
    @ApiQuery({
        name: 'shop_domain',
        required: false,
        example: 'store.myshopify.com',
    })
    @ApiOkResponse({ type: IntegrationLocationListDto })
    async list(
        @Req() req: Request & { organisationId: string },
        @Query('platform') platform?: string,
        @Query('shop_domain') shopDomain?: string,
    ): Promise<IntegrationLocationListDto> {
        if (platform !== undefined && !/^[a-z0-9-]+$/.test(platform)) {
            throw new BadRequestException(
                'platform must be a lowercase slug (a-z, 0-9, -)',
            );
        }
        const data = await this.mappings.list(req.organisationId, {
            platform,
            shopDomain,
        });
        return { data };
    }

    @Put()
    @HttpCode(HttpStatus.OK)
    @RequirePermission('integrations.locations.write')
    @ApiOperation({
        summary: "Upsert a shop's locations and their warehouse mappings.",
        description:
            "Upserts one shop's locations in one transaction, keyed by " +
            '(platform, shop_domain, external_location_id). Returns all the ' +
            "shop's locations.",
    })
    @ApiBody({ type: UpsertIntegrationLocationsDto })
    @ApiOkResponse({ type: IntegrationLocationListDto })
    @ApiNotFound('A `warehouse_id` is not a warehouse of this organisation.')
    async upsert(
        @Body() dto: UpsertIntegrationLocationsDto,
        @Req() req: Request & { organisationId: string; user: AuthedUser },
    ): Promise<IntegrationLocationListDto> {
        const data = await this.mappings.upsert(
            req.organisationId,
            req.user.id,
            dto,
        );
        return { data };
    }
}
