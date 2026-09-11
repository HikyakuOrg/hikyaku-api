import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import {
    ApiConflict,
    ApiGuardErrors,
    ApiNotFound,
} from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { SkillsService } from './skills.service';
import { CreateSkillDto, SkillDto } from './dto/skill.dto';

/**
 * The organisation's skill catalog. Gated on the same 'vehicles.view' /
 * 'vehicles.update' permissions as the vehicles endpoints rather than a new
 * permission of its own — skills are fleet capability data, assigned to
 * vehicles, and HIK-95 places the dashboard UI for this inside Fleet >
 * Vehicles for the same reason. See CreateSkillsSchema1789261200000 for the
 * full argument.
 */
@ApiTags('skills')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/skills')
@UseGuards(PermissionGuard)
export class SkillsController {
    constructor(private readonly skills: SkillsService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('vehicles.update')
    @ApiOperation({ summary: 'Add a skill to the organisation catalog.' })
    @ApiBody({ type: CreateSkillDto })
    @ApiCreatedResponse({ type: SkillDto })
    @ApiConflict('A skill with this name already exists in the organisation.')
    create(
        @Body() dto: CreateSkillDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<SkillDto> {
        return this.skills.create(req.organisationId, dto);
    }

    @Get()
    @RequirePermission('vehicles.view')
    @ApiOperation({
        summary: 'List the organisation skill catalog, newest first.',
    })
    @ApiQuery({
        name: 'includeArchived',
        required: false,
        type: Boolean,
        description: 'Include retired skills. Defaults to false.',
    })
    @ApiOkResponse({ type: [SkillDto] })
    list(
        @Query('includeArchived') includeArchived: string | undefined,
        @Req() req: Request & { organisationId: string },
    ): Promise<SkillDto[]> {
        return this.skills.list(req.organisationId, includeArchived === 'true');
    }

    @Post(':id/archive')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.update')
    @ApiOperation({
        summary: 'Retire a skill.',
        description:
            'Idempotent. Archived skills cannot be newly assigned to a vehicle ' +
            'or required on a package, but existing assignments and historical ' +
            'routes keep referencing them — there is no hard delete.',
    })
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ type: SkillDto })
    @ApiNotFound('No skill with this id in the organisation.')
    archive(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<SkillDto> {
        return this.skills.archive(req.organisationId, id);
    }
}
