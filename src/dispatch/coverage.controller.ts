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
import { CoverageDiagnosticsService } from './coverage-diagnostics.service';
import {
    CoverageDiagnosticDto,
    CoverageSummaryDto,
} from './dto/coverage-diagnostic.dto';

/**
 * The dispatch diagnostic surface: one read, no writes.
 *
 * It lives in the dispatch module rather than on the shifts or packages
 * controller because the question it answers is a dispatch-engine question, and
 * the code that answers it (`coverage.ts`) is the same code the assignment
 * engine decides with. Hanging it off shifts would put the explanation of a
 * decision in a different bounded context from the decision.
 *
 * THERE IS NO WRITE PATH HERE, DELIBERATELY. Territories and their staffing are
 * written by the web dashboard straight through PostgREST under RLS, which is
 * why `service_areas` and `driver_service_area` have RLS policies and this API
 * has no endpoints for them. A POST or PUT added here would be a second, weaker
 * write path around those policies, since this process connects as
 * `service_role` and bypasses RLS entirely.
 */
@ApiTags('dispatch')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/dispatch')
@UseGuards(PermissionGuard)
export class CoverageController {
    constructor(private readonly diagnostics: CoverageDiagnosticsService) {}

    /**
     * Declared BEFORE the `coverage` route below.
     *
     * Fastify's router matches static segments ahead of anything else, so the
     * order does not actually decide this one, but keeping the more specific
     * path first is the convention that stays correct if either ever gains a
     * parameter.
     */
    @Get('coverage/summary')
    @RequirePermission('shifts.view')
    @ApiOperation({
        summary:
            'How much of this organisation’s traffic reaches a covering driver.',
        description:
            'The rollout number: over the last N days, what fraction of the ' +
            'packages automatic assignment placed reached a driver whose ' +
            'territory covers the delivery point (or who has no territories at ' +
            'all and therefore covers everywhere).\n\n' +
            'This is what to check before switching service area matching on ' +
            'for real traffic, and every day for a week afterwards. It also ' +
            'names the most recent packages that went to a driver who does NOT ' +
            'cover them, which is the "which ones, and why" question; pass any ' +
            'of those ids to GET /api/v1/dispatch/coverage for the full ' +
            'explanation of one.\n\n' +
            'Counts only packages automatic assignment placed. A package a ' +
            'dispatcher pinned by hand took no coverage decision and is not in ' +
            'either the numerator or the denominator.',
    })
    @ApiQuery({
        name: 'days',
        required: false,
        type: Number,
        description:
            'How many days back to count, 1 to 30. Defaults to 7, which is a ' +
            'whole weekly delivery cycle: anything shorter compares a weekday ' +
            'against a weekend and reads the difference as a change in ' +
            'coverage.',
        example: 7,
    })
    @ApiResponse({
        status: 200,
        description:
            'The covered rate, the five outcome buckets behind it, the live ' +
            'territory count needed to interpret it, and a sample of the ' +
            'packages that fell back.',
        type: CoverageSummaryDto,
    })
    @ApiResponse({
        status: 400,
        description: '`days` is not a whole number between 1 and 30.',
        type: ApiErrorDto,
    })
    summary(
        @Req() req: Request & { organisationId: string },
        @Query('days') days?: string,
    ): Promise<CoverageSummaryDto> {
        return this.diagnostics.summary(req.organisationId, days);
    }

    @Get('coverage')
    // Same permission as the other read-only views of a dispatch decision
    // (GET /shifts/{id}/version, GET /optimisation/run/latest). A caller who can
    // see which driver a shift belongs to is exactly the caller who can be told
    // why a package reached that driver, and there is no service_areas.view
    // permission to gate on: service_areas.edit is the only one that exists, and
    // requiring a write permission for a read would be the wrong trade.
    @RequirePermission('shifts.view')
    @ApiOperation({
        summary: 'Explain which drivers cover a delivery point, and why.',
        description:
            'The support answer to "why did package X go to driver Y?". Pass ' +
            '`packageId` for a package that exists, or `lon` and `lat` to ask ' +
            'about an address before one does. Exactly one of the two forms per ' +
            'request.\n\n' +
            'The containment test is the same call the assignment engine makes ' +
            '(`src/dispatch/coverage.ts`), not a second implementation of it, so ' +
            'this endpoint cannot disagree with what dispatch actually did.\n\n' +
            'Read-only. Territories and their staffing are written by the web ' +
            'dashboard directly, under row level security.',
    })
    @ApiQuery({
        name: 'packageId',
        required: false,
        type: String,
        format: 'uuid',
        description:
            'The package to explain. Its delivery point and warehouse are ' +
            'resolved from the package itself, so `lon`, `lat` and `warehouseId` ' +
            'must not be sent with it.',
    })
    @ApiQuery({
        name: 'lon',
        required: false,
        type: Number,
        description:
            'Longitude, WGS84, within +/-180. Must be sent with `lat`.',
        example: 103.851959,
    })
    @ApiQuery({
        name: 'lat',
        required: false,
        type: Number,
        description: 'Latitude, WGS84, within +/-90. Must be sent with `lon`.',
        example: 1.29027,
    })
    @ApiQuery({
        name: 'warehouseId',
        required: false,
        type: String,
        format: 'uuid',
        description:
            'Which warehouse’s drivers to consider, for the coordinate form. ' +
            'Optional when the organisation has exactly one warehouse; required ' +
            'when it has several.',
    })
    @ApiQuery({
        name: 'includeGeometry',
        required: false,
        type: Boolean,
        description:
            'Adds each matching territory’s GeoJSON polygon. Off by default: a ' +
            'few city-sized territories are megabytes of coordinates.',
    })
    @ApiResponse({
        status: 200,
        description:
            'The point that was tested, the territories covering it, every ' +
            'driver covering it (flagged as an explicit territory match or as a ' +
            'floater with no territories at all), and, for the package form, who ' +
            'actually got it and whether coverage explains that.\n\n' +
            'A package with no geocode is answered here, not with an error: ' +
            '`resolution` says `package_not_geocoded`, which is a different and ' +
            'more actionable answer than a geocoded address nobody covers.',
        type: CoverageDiagnosticDto,
    })
    @ApiResponse({
        status: 400,
        description:
            'Both request forms sent, or neither; `lon` without `lat`; a ' +
            'coordinate outside +/-180 by +/-90 (usually a lon/lat swap); ' +
            '`warehouseId` sent alongside `packageId`; or the coordinate form ' +
            'with no `warehouseId` in an organisation that has several ' +
            'warehouses.',
        type: ApiErrorDto,
    })
    @ApiResponse({
        status: 404,
        description:
            'No package, or no warehouse, with that id in the organisation. ' +
            'Rows belonging to another organisation are reported as unknown, ' +
            'never as forbidden.',
        type: ApiErrorDto,
    })
    coverage(
        // First, rather than last as the other controllers have it, only
        // because every query parameter here is optional and TypeScript wants
        // the required one ahead of them. The organisation comes from
        // PermissionGuard and never from the query string: this process
        // bypasses RLS, so a caller-supplied organisation id would be a
        // cross-tenant read.
        @Req() req: Request & { organisationId: string },
        @Query('packageId') packageId?: string,
        @Query('lon') lon?: string,
        @Query('lat') lat?: string,
        @Query('warehouseId') warehouseId?: string,
        @Query('includeGeometry') includeGeometry?: string,
    ): Promise<CoverageDiagnosticDto> {
        return this.diagnostics.explain(req.organisationId, {
            packageId,
            lon,
            lat,
            warehouseId,
            includeGeometry,
        });
    }
}
