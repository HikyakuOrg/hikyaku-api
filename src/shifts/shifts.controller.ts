import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { AddPackagesToShiftDto, CreateShiftDto } from './dto/create-shift.dto';
import {
    ShiftDto,
    ShiftPlanDto,
    ShiftVersionDto,
} from './dto/shift-result.dto';
import { ShiftsService } from './shifts.service';

@ApiTags('shifts')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/shifts')
@UseGuards(PermissionGuard)
export class ShiftsController {
    constructor(private readonly shifts: ShiftsService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('shifts.assign')
    @ApiBody({ type: CreateShiftDto })
    @ApiResponse({
        status: 201,
        description:
            'Empty planned shift created. This consumes one shift from the ' +
            'organisation allowance.',
        type: ShiftDto,
    })
    @ApiResponse({
        status: 402,
        description:
            'The organisation is over its free shift allowance and has no payment ' +
            'method on file.',
        type: ApiErrorDto,
    })
    @ApiResponse({
        status: 409,
        description:
            'That driver or vehicle already has an open shift on this date.',
        type: ApiErrorDto,
    })
    create(
        @Body() dto: CreateShiftDto,
        @Req() req: Request & { organisationId: string; user: { id: string } },
    ): Promise<ShiftDto> {
        return this.shifts.create(req.organisationId, dto);
    }

    @Get(':id/version')
    @RequirePermission('shifts.view')
    @ApiResponse({
        status: 200,
        description:
            'Cheap change check — one indexed row. The driver app polls this while ' +
            'a shift screen is in the foreground and reloads only when `revision` ' +
            'moves, so a package added to a planned shift is never silently absent.',
        type: ShiftVersionDto,
    })
    version(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<ShiftVersionDto> {
        return this.shifts.version(req.organisationId, id);
    }

    @Post(':id/dispatch')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('shifts.assign')
    @ApiResponse({
        status: 200,
        description:
            'Moves the shift planned to dispatched, closing it to automatic ' +
            'assignment.',
        type: ShiftDto,
    })
    @ApiResponse({
        status: 409,
        description: 'The shift is not in the planned state.',
        type: ApiErrorDto,
    })
    dispatch(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<ShiftDto> {
        return this.shifts.dispatch(req.organisationId, id);
    }

    @Post(':id/packages')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('shifts.assign')
    @ApiBody({ type: AddPackagesToShiftDto })
    @ApiResponse({
        status: 200,
        description:
            'Dispatcher override: pins the packages to this shift and returns the ' +
            'rewritten plan. Feasibility still runs, but a breach is reported as a ' +
            'warning rather than refused.',
        type: ShiftPlanDto,
    })
    @ApiResponse({
        status: 409,
        description: 'The shift is already dispatched.',
        type: ApiErrorDto,
    })
    addPackages(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: AddPackagesToShiftDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<ShiftPlanDto> {
        return this.shifts.addPackages(req.organisationId, id, dto);
    }

    @Delete(':id/packages/:packageId')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('shifts.assign')
    @ApiResponse({
        status: 200,
        description:
            'Removes the package and returns the rewritten plan. The route steps ' +
            'are deleted and re-inserted in order rather than renumbered.',
        type: ShiftPlanDto,
    })
    @ApiResponse({
        status: 409,
        description:
            'The package is loaded, in transit or already delivered, so it cannot ' +
            'be removed.',
        type: ApiErrorDto,
    })
    removePackage(
        @Param('id', ParseUUIDPipe) id: string,
        @Param('packageId', ParseUUIDPipe) packageId: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<ShiftPlanDto> {
        return this.shifts.removePackage(req.organisationId, id, packageId);
    }
}
