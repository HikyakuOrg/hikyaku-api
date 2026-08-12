import {
    Body,
    Controller,
    Delete,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import {
    ApiGuardErrors,
    ApiNotFound,
} from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { CreateAddonDto } from './dto/create-addon.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { UpdateAddonDto } from './dto/update-addon.dto';
import { ServiceRefDto } from './dto/service-catalog.dto';

/**
 * Admin CRUD for the service catalog. Org-admin function, so it reuses the same
 * vehicles.* grants the Connect/Issuing setup gates on (view = read, add =
 * mutate). PermissionGuard resolves req.organisationId from the
 * X-Organisation-Slug header and scopes every query to it.
 *
 * Every route here is authenticated — the public booking endpoints on the same
 * base path live in services-public.controller.ts.
 */
@ApiTags('services')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/services')
@UseGuards(PermissionGuard)
export class ServicesController {
    constructor(private readonly services: ServicesService) {}

    @Post()
    // 200 rather than the usual 201 for a create. Left as-is because changing it
    // would break existing callers; the spec documents what actually happens.
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Create a service.',
        description:
            'Creates a Stripe product and its default price on the organisation’s ' +
            'connected account. Responds 200, not 201.',
    })
    @ApiOkResponse({ type: ServiceRefDto })
    create(
        @Body() dto: CreateServiceDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<ServiceRefDto> {
        return this.services.createService(req.organisationId, dto);
    }

    @Patch(':id')
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Update a service.',
        description:
            'Name and pricing unit are patched in place. A price change mints a ' +
            'new Stripe price and archives the old one — the returned id is ' +
            'unchanged either way. Currency is not editable.',
    })
    @ApiParam({ name: 'id', description: 'Stripe product id of the service.' })
    @ApiOkResponse({ type: ServiceRefDto })
    @ApiNotFound('No service with this id on the organisation’s account.')
    update(
        @Param('id') id: string,
        @Body() dto: UpdateServiceDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<ServiceRefDto> {
        return this.services.updateService(req.organisationId, id, dto);
    }

    @Delete(':id')
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Archive a service and its add-ons.',
        description:
            'Deactivates the Stripe product and price rather than deleting them, ' +
            'so historical payments keep resolving. Child add-ons are archived ' +
            'first.',
    })
    @ApiParam({ name: 'id', description: 'Stripe product id of the service.' })
    @ApiOkResponse({ description: 'Archived. Empty body.' })
    @ApiNotFound('No service with this id on the organisation’s account.')
    remove(
        @Param('id') id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<void> {
        return this.services.deleteService(req.organisationId, id);
    }

    @Post(':id/addons')
    // 200 rather than 201, matching the service create above.
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Add an add-on to a service.',
        description:
            'The add-on inherits the parent service’s currency. Responds 200, not ' +
            '201.',
    })
    @ApiParam({
        name: 'id',
        description: 'Stripe product id of the parent service.',
    })
    @ApiOkResponse({ type: ServiceRefDto })
    @ApiNotFound('No service with this id on the organisation’s account.')
    addAddon(
        @Param('id') id: string,
        @Body() dto: CreateAddonDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<ServiceRefDto> {
        return this.services.createAddon(req.organisationId, id, dto);
    }

    @Patch('addons/:addonId')
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Update an add-on.',
        description:
            'Same price semantics as updating a service: a new Stripe price is ' +
            'minted and the id stays stable.',
    })
    @ApiParam({
        name: 'addonId',
        description: 'Stripe product id of the add-on.',
    })
    @ApiOkResponse({ type: ServiceRefDto })
    @ApiNotFound('No add-on with this id on the organisation’s account.')
    updateAddon(
        @Param('addonId') addonId: string,
        @Body() dto: UpdateAddonDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<ServiceRefDto> {
        return this.services.updateAddon(req.organisationId, addonId, dto);
    }

    @Delete('addons/:addonId')
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Archive an add-on.',
        description:
            'Deactivates the Stripe product and price; the parent service is ' +
            'untouched.',
    })
    @ApiParam({
        name: 'addonId',
        description: 'Stripe product id of the add-on.',
    })
    @ApiOkResponse({ description: 'Archived. Empty body.' })
    @ApiNotFound('No add-on with this id on the organisation’s account.')
    removeAddon(
        @Param('addonId') addonId: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<void> {
        return this.services.deleteAddon(req.organisationId, addonId);
    }
}
