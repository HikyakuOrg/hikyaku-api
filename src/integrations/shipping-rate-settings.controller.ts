import {
    BadRequestException,
    Body,
    Controller,
    Delete,
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
    ApiExtraModels,
    ApiNoContentResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import type { AuthedUser } from 'src/auth/authed-user';
import {
    BandSettingDto,
    PutShippingRateSettingsDto,
    ShippingRateErrorDto,
    ShippingRateSettingsResponseDto,
    ShippingRateSettingsViewResponseDto,
} from './dto/shipping-rate-settings.dto';
import { ShippingRateSettingsService } from './shipping-rate-settings.service';

/**
 * Which catalog services a storefront shop offers as checkout shipping
 * rates. `platform` is a data value, as on the locations routes.
 */
@ApiTags('integrations')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@ApiExtraModels(BandSettingDto)
@Controller('api/v1/integrations/shipping-rates')
@UseGuards(PermissionGuard)
export class ShippingRateSettingsController {
    constructor(private readonly settings: ShippingRateSettingsService) {}

    // Same permission as GET /api/v1/integrations/locations, so a user who
    // can see the mapping can see the rates.
    @Get()
    @RequirePermission('warehouse.view')
    @ApiOperation({
        summary:
            "A shop's checkout rate settings and the services it can offer.",
        description:
            'Settings are the defaults (disabled, no services) when none are ' +
            'stored. `services` lists the catalog with each amount in ' +
            '`currency`, or the stored shop currency when omitted.',
    })
    @ApiQuery({ name: 'platform', example: 'shopify' })
    @ApiQuery({ name: 'shop_domain', example: 'store.myshopify.com' })
    @ApiQuery({ name: 'currency', required: false, example: 'AUD' })
    @ApiOkResponse({ type: ShippingRateSettingsViewResponseDto })
    async get(
        @Req() req: Request & { organisationId: string },
        @Query('platform') platform?: string,
        @Query('shop_domain') shopDomain?: string,
        @Query('currency') currency?: string,
    ): Promise<ShippingRateSettingsViewResponseDto> {
        const shop = parseShop(platform, shopDomain);
        if (currency !== undefined && !/^[A-Za-z]{3}$/.test(currency)) {
            throw new BadRequestException(
                'currency must be a three-letter ISO 4217 code',
            );
        }
        const data = await this.settings.getView(
            req.organisationId,
            shop.platform,
            shop.shopDomain,
            currency,
        );
        return { data };
    }

    @Put()
    @HttpCode(HttpStatus.OK)
    @RequirePermission('integrations.shipping_rates.write')
    @ApiOperation({
        summary: "Store a shop's checkout rate settings.",
        description:
            'Enabling needs a connected Stripe account, at least one chosen ' +
            'service, and an amount in `shop_currency` on each (main price or ' +
            '`currency_options`). Disabling always succeeds. A 422 carries a ' +
            '`code` the connector can show.',
    })
    @ApiBody({ type: PutShippingRateSettingsDto })
    @ApiOkResponse({ type: ShippingRateSettingsResponseDto })
    @ApiResponse({
        status: 409,
        description: 'Another organisation holds this shop.',
        type: ApiErrorDto,
    })
    @ApiResponse({
        status: 422,
        description: 'The settings cannot be enabled as sent.',
        type: ShippingRateErrorDto,
    })
    async put(
        @Body() dto: PutShippingRateSettingsDto,
        @Req() req: Request & { organisationId: string; user: AuthedUser },
    ): Promise<ShippingRateSettingsResponseDto> {
        const data = await this.settings.put(
            req.organisationId,
            req.user.id,
            dto,
        );
        return { data };
    }

    @Delete()
    @HttpCode(HttpStatus.NO_CONTENT)
    @RequirePermission('integrations.shipping_rates.write')
    @ApiOperation({
        summary: "Delete a shop's checkout rate settings.",
        description:
            'For disconnect and shop redact. Checkout stops getting rates at ' +
            'once. 204 even when nothing was stored.',
    })
    @ApiQuery({ name: 'platform', example: 'shopify' })
    @ApiQuery({ name: 'shop_domain', example: 'store.myshopify.com' })
    @ApiNoContentResponse({ description: 'Deleted.' })
    async remove(
        @Req() req: Request & { organisationId: string },
        @Query('platform') platform?: string,
        @Query('shop_domain') shopDomain?: string,
    ): Promise<void> {
        const shop = parseShop(platform, shopDomain);
        await this.settings.remove(
            req.organisationId,
            shop.platform,
            shop.shopDomain,
        );
    }
}

function parseShop(
    platform: string | undefined,
    shopDomain: string | undefined,
): { platform: string; shopDomain: string } {
    if (!platform || !/^[a-z0-9-]+$/.test(platform)) {
        throw new BadRequestException(
            'platform must be a lowercase slug (a-z, 0-9, -)',
        );
    }
    if (!shopDomain?.trim()) {
        throw new BadRequestException('shop_domain is required');
    }
    return { platform, shopDomain };
}
