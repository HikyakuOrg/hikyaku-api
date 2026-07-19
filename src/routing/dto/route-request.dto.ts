import { ApiProperty } from '@nestjs/swagger';
import {
    ArrayMinSize,
    IsArray,
    IsNotEmpty,
    IsString,
    Validate,
    ValidatorConstraint,
    ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'coordinatePairs', async: false })
export class CoordinatePairsConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return (
            Array.isArray(value) &&
            value.every(
                (pair) =>
                    Array.isArray(pair) &&
                    pair.length === 2 &&
                    pair.every((n) => typeof n === 'number' && Number.isFinite(n)),
            )
        );
    }

    defaultMessage(): string {
        return 'coordinates must be an array of [lng, lat] number pairs';
    }
}

/**
 * Body for POST /api/v1/routing/route. The org is resolved from the x-org-slug
 * header (public endpoint). `coordinates` are [lng, lat] pairs visited in order;
 * at least two are required to form a route.
 */
export class RouteRequestDto {
    @ApiProperty({ description: "ORS-style vehicle profile, e.g. 'driving-car'." })
    @IsString()
    @IsNotEmpty()
    profile: string;

    // The schema is spelled out rather than inferred: a tuple type erases to
    // Array at runtime, so without this the generated spec typed coordinates as
    // array<string> and clients emitted List<String> instead of [lng, lat] pairs.
    @ApiProperty({
        description: 'Stops to route through, as [lng, lat] pairs in visit order.',
        type: 'array',
        minItems: 2,
        items: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
        },
        example: [
            [103.85, 1.29],
            [103.86, 1.3],
        ],
    })
    @IsArray()
    @ArrayMinSize(2)
    @Validate(CoordinatePairsConstraint)
    coordinates: [number, number][];
}
