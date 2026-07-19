import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiForbiddenResponse,
    ApiHeader,
    ApiResponse,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { OptimisationService } from './optimisation.service';
import { RunOptimisationDto } from './dto/run-optimisation.dto';
import { AdhocOptimisationDto } from './dto/adhoc-optimisation.dto';
import {
    AdhocOptimisationResultDto,
    LatestOptimisationRunDto,
    RunOptimisationResultDto,
} from './dto/optimisation-result.dto';

@ApiTags('optimisation')
@ApiBearerAuth('bearer')
@ApiHeader({
    name: 'X-Organisation-Slug',
    required: true,
    description: 'Slug of the organisation the request acts on.',
})
@ApiUnauthorizedResponse({ description: 'Missing, malformed or expired bearer token.' })
@ApiForbiddenResponse({
    description:
        'Unknown organisation, caller is not a member of it, or the required ' +
        'permission is missing.',
})
@Controller('api/v1/optimisation')
@UseGuards(PermissionGuard)
export class OptimisationController {
    constructor(private readonly optimisation: OptimisationService) { }

    @Post('run')
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePermission('shifts.assign')
    @ApiResponse({
        status: 202,
        description: 'Optimisation queued',
        type: RunOptimisationResultDto,
    })
    @ApiResponse({ status: 429, description: 'Rate limited (see nextAllowedAt)' })
    run(
        @Body() dto: RunOptimisationDto,
        @Req() req: Request & { organisationId: string; user: { id: string } },
    ) {
        return this.optimisation.triggerRun(req.organisationId, req.user.id, dto);
    }

    @Get('run/latest')
    @RequirePermission('shifts.view')
    @ApiResponse({
        status: 200,
        description:
            'Most recent run + next allowed time, or null if the organisation has ' +
            'never run an optimisation.',
        type: LatestOptimisationRunDto,
    })
    latest(@Req() req: Request & { organisationId: string }) {
        return this.optimisation.getLatest(req.organisationId);
    }

    @Post('adhoc')
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('shifts.assign')
    @ApiBody({ type: AdhocOptimisationDto })
    @ApiResponse({
        status: 201,
        description:
            'Optimised route persisted and the routed packages claimed; returns the ' +
            'vrp_optimization id plus any packages VROOM could not fit.',
        type: AdhocOptimisationResultDto,
    })
    @ApiResponse({
        status: 400,
        description:
            'Unknown warehouse/vehicle type, or a package that is unknown, not at ' +
            'startingLocationId, or whose recipient has no location.',
    })
    @ApiResponse({
        status: 409,
        description: 'A package is already assigned to another optimisation.',
    })
    adhoc(
        @Body() dto: AdhocOptimisationDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.optimisation.runAdhoc(req.organisationId, dto);
    }
}
