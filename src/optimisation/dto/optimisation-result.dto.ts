import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response schemas for the optimisation endpoints. These mirror the objects
 * OptimisationService already returns; nothing constructs them, so they carry
 * declarations only and exist purely to give the document a 2xx body.
 */

/** 201 body of POST /api/v1/optimisation/adhoc. */
export class AdhocOptimisationResultDto {
    @ApiProperty({
        format: 'uuid',
        description: 'vrp_optimization.id of the persisted optimisation.',
    })
    id: string;

    // `type` is explicit on every nullable field below: a `string | null` TS type
    // reflects as Object, which the generator turns into an untyped `Any?`.
    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'vrp_route.id of the single routed vehicle, or null when VROOM ' +
            'produced no route.',
    })
    routeId: string | null;

    @ApiProperty({
        type: [String],
        format: 'uuid',
        description:
            'Requested packages VROOM could not fit into the shift. Empty when ' +
            'every package was assigned.',
    })
    unassignedPackageIds: string[];
}

/** 202 body of POST /api/v1/optimisation/run. */
export class RunOptimisationResultDto {
    @ApiProperty({
        format: 'uuid',
        description: 'optimisation_run.id of the queued run.',
    })
    runId: string;

    @ApiProperty({ enum: ['queued'], example: 'queued' })
    status: 'queued';
}

/**
 * 200 body of GET /api/v1/optimisation/run/latest. The endpoint answers with
 * null when the organisation has never run an optimisation.
 */
export class LatestOptimisationRunDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({
        description: 'Run lifecycle state, e.g. `queued`, `failed`, `skipped`.',
    })
    status: string;

    @ApiProperty({
        format: 'date-time',
        description: 'When the run was requested.',
    })
    requestedAt: string;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'vrp_optimization.id once the run has produced one.',
    })
    optimisationId: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Failure detail when status is `failed`.',
    })
    error: string | null;

    @ApiPropertyOptional({
        type: String,
        format: 'date-time',
        nullable: true,
        description:
            'Earliest time another run is allowed. Null when this run does not ' +
            'count toward the rate limit (failed or skipped).',
    })
    nextAllowedAt: string | null;
}
