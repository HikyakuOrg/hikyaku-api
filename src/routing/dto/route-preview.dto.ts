import { ApiProperty } from '@nestjs/swagger';
import type { RoutePreview, RouteLeg } from 'src/valhalla/route-preview.types';

/**
 * Swagger view of the RoutePreview contract in
 * `src/valhalla/route-preview.types.ts` — the interfaces there stay the source
 * of truth for the service layer, and these classes exist only so the document
 * has a response schema (interfaces vanish at runtime, so decorators need a
 * class to hang off). `implements` keeps the two from drifting apart: a field
 * renamed or retyped in the interface fails the build here.
 */
export class RouteLegDto implements RouteLeg {
    @ApiProperty({ description: 'Travel time in seconds.' })
    duration: number;

    @ApiProperty({ description: 'Distance in meters.' })
    distance: number;
}

export class RouteSummaryDto {
    @ApiProperty({ description: 'Total travel time in seconds.' })
    duration: number;

    @ApiProperty({ description: 'Total distance in meters.' })
    distance: number;
}

export class RoutePreviewDto implements RoutePreview {
    @ApiProperty({
        description:
            'Whole-route path as [lng, lat] pairs, legs concatenated with shared ' +
            'boundary points de-duplicated.',
        type: 'array',
        items: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
        },
        example: [
            [103.85, 1.29],
            [103.8555, 1.2945],
            [103.86, 1.3],
        ],
    })
    coordinates: [number, number][];

    @ApiProperty({
        type: [Number],
        description:
            'Index into `coordinates` of each stop. wayPoints[0] is 0 and the ' +
            'last entry is coordinates.length - 1.',
        example: [0, 2],
    })
    wayPoints: number[];

    @ApiProperty({
        type: [RouteLegDto],
        description: 'Per stop-pair legs — n stops yield n-1 legs.',
    })
    legs: RouteLegDto[];

    @ApiProperty({ type: RouteSummaryDto })
    summary: RouteSummaryDto;
}
