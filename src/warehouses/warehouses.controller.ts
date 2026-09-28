import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { WarehouseListDto } from './dto/warehouse.dto';
import { WarehousesService } from './warehouses.service';

@ApiTags('warehouses')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/warehouses')
@UseGuards(PermissionGuard)
export class WarehousesController {
    constructor(private readonly warehouses: WarehousesService) {}

    // The same permission as the "warehouse select org or own" RLS policy.
    @Get()
    @RequirePermission('warehouse.view')
    @ApiOperation({
        summary: "List the organisation's warehouses.",
        description:
            'Ordered by name. Storefront connectors use it to map locations ' +
            'to warehouses (PUT /api/v1/integrations/locations).',
    })
    @ApiOkResponse({ type: WarehouseListDto })
    async list(
        @Req() req: Request & { organisationId: string },
    ): Promise<WarehouseListDto> {
        const data = await this.warehouses.list(req.organisationId);
        return { data };
    }
}
