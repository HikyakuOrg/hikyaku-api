import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
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
import { DrivingLimitsDiagnosticsService } from './driving-limits-diagnostics.service';
import { DrivingLimitsSummaryDto } from './dto/driving-limits-diagnostic.dto';

/**
 * The driving-limits planning surface: one read, no writes.
 *
 * Lives alongside CoverageController for the same reason given there: the
 * question is a dispatch-engine question, and it is answered by the pure
 * evaluator (`driving-limits-diagnostics.ts`) the engine's own gates run on
 * (HIK-83's Tier 1 checks, HIK-84's VROOM guard), not a second
 * implementation of "did this shift breach".
 *
 * THERE IS NO WRITE PATH HERE, DELIBERATELY. `driving_limit_profile` rows are
 * written by the dashboard through PostgREST under RLS. This process
 * connects as `service_role` and bypasses RLS entirely, so a POST or PUT
 * added here would be a second, weaker write path around those policies.
 */
@ApiTags('dispatch')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/dispatch/driving-limits')
@UseGuards(PermissionGuard)
export class DrivingLimitsController {
    constructor(
        private readonly diagnostics: DrivingLimitsDiagnosticsService,
    ) {}

    @Get('summary')
    @RequirePermission('shifts.view')
    @ApiOperation({
        summary:
            'What would a proposed set of driving limits have done to this fleet?',
        description:
            'Over the last N days, the distribution of what shifts actually ' +
            'ran (working hours, driving hours, distance, stop count), and, ' +
            'against a PROPOSED set of caps passed as query parameters, how ' +
            'many of those shifts would have breached each one and which ' +
            'packages sit on the breaching portion of the route.\n\n' +
            'The proposed limits are query parameters, never the configured ' +
            '`driving_limit_profile` rows, which is what makes this a ' +
            'planning tool rather than a report: a dispatcher can ask "what ' +
            'would 200 km have done to last month" without saving anything.\n\n' +
            'Driving-hours figures are an ESTIMATE (elapsed time minus total ' +
            'service time), not VROOM’s own measured travel time — see ' +
            '`drivingSecondsIsEstimated` on the response for why.',
    })
    @ApiQuery({
        name: 'days',
        required: false,
        type: Number,
        description:
            'How many days back to look, 1 to 30. Defaults to 30: a driving ' +
            'limit is chosen once and left mostly alone, so a representative ' +
            'month is the useful window, unlike a rollout rate that is ' +
            'watched daily.',
        example: 30,
    })
    @ApiQuery({
        name: 'maxWorkingSeconds',
        required: false,
        type: Number,
        description:
            'Proposed cap on elapsed departure-to-return time, seconds. Omit ' +
            'to not test this dimension.',
    })
    @ApiQuery({
        name: 'maxDrivingSeconds',
        required: false,
        type: Number,
        description:
            'Proposed cap on travel-only time, seconds. Omit to not test ' +
            'this dimension.',
    })
    @ApiQuery({
        name: 'maxDistanceM',
        required: false,
        type: Number,
        description:
            'Proposed cap on total route distance, METRES. Omit to not test ' +
            'this dimension.',
    })
    @ApiQuery({
        name: 'maxStops',
        required: false,
        type: Number,
        description:
            'Proposed cap on job stop count. Omit to not test this dimension.',
    })
    @ApiResponse({
        status: 200,
        description:
            'The realised distribution, the proposed limits echoed back, and ' +
            'the shifts (if any were proposed) that would have breached them.',
        type: DrivingLimitsSummaryDto,
    })
    @ApiResponse({
        status: 400,
        description:
            '`days` is not a whole number between 1 and 30, or a proposed ' +
            'limit is not a positive whole number.',
        type: ApiErrorDto,
    })
    summary(
        @Req() req: Request & { organisationId: string },
        @Query('days') days?: string,
        @Query('maxWorkingSeconds') maxWorkingSeconds?: string,
        @Query('maxDrivingSeconds') maxDrivingSeconds?: string,
        @Query('maxDistanceM') maxDistanceM?: string,
        @Query('maxStops') maxStops?: string,
    ): Promise<DrivingLimitsSummaryDto> {
        return this.diagnostics.summary(req.organisationId, {
            days,
            maxWorkingSeconds,
            maxDrivingSeconds,
            maxDistanceM,
            maxStops,
        });
    }
}
