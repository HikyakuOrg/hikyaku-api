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
 * Storefront locations and the warehouse each one ships from. Like
 * IntegrationsController, never named after a platform: `platform` is a data
 * value, so every connector shares these two routes.
 */
@ApiTags('integrations')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/integrations/locations')
@UseGuards(PermissionGuard)
export class LocationMappingsController {
    constructor(private readonly mappings: LocationMappingsService) {}

    // Reads need warehouse.view, the same as GET /api/v1/warehouses: a
    // mapping is only readable alongside the warehouses it points at.
    @Get()
    @RequirePermission('warehouse.view')
    @ApiOperation({
        summary: 'List storefront locations and where each ships from.',
        description:
            'Ordered by platform, shop, then live locations before stale ' +
            'ones. Stale locations (no longer reported by the storefront) ' +
            'are included, with `stale_at` set.',
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
            'Creates or updates each location of one shop, keyed by ' +
            '(platform, shop_domain, external_location_id), in one ' +
            'transaction. A location sent without `mode` keeps its current ' +
            'mode and warehouse (a new one starts `unmapped`). With ' +
            "`mark_missing_stale`, the shop's locations not in the body are " +
            'marked stale, never deleted. Returns every location of the shop ' +
            'afterwards.',
    })
    @ApiBody({ type: UpsertIntegrationLocationsDto })
    @ApiOkResponse({ type: IntegrationLocationListDto })
    @ApiNotFound(
        'A `warehouse_id` is not a warehouse of this organisation (another ' +
            "organisation's warehouse gets the same answer as a missing one).",
    )
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
