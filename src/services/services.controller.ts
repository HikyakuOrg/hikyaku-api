import {
    Body,
    Controller,
    Delete,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { CreateAddonDto } from './dto/create-addon.dto';

/**
 * Admin CRUD for the service catalog. Org-admin function, so it reuses the same
 * vehicles.* grants the Connect/Issuing setup gates on (view = read, add =
 * mutate). PermissionGuard resolves req.organisationId from the
 * X-Organisation-Slug header and scopes every query to it.
 */
@ApiTags('services')
@Controller('api/v1/services')
@UseGuards(PermissionGuard)
export class ServicesController {
    constructor(private readonly services: ServicesService) {}

    @Post()
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    create(
        @Body() dto: CreateServiceDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.services.createService(req.organisationId, dto);
    }

    @Delete(':id')
    @RequirePermission('vehicles.add')
    remove(
        @Param('id') id: string,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.services.deleteService(req.organisationId, id);
    }

    @Post(':id/addons')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    addAddon(
        @Param('id') id: string,
        @Body() dto: CreateAddonDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.services.createAddon(req.organisationId, id, dto);
    }

    @Delete('addons/:addonId')
    @RequirePermission('vehicles.add')
    removeAddon(
        @Param('addonId') addonId: string,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.services.deleteAddon(req.organisationId, addonId);
    }
}
