import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shape of the geocode proxy. Photon answers with GeoJSON, and the
 * proxy passes the body through verbatim, so these classes describe Photon's
 * output rather than a Whendan-owned contract.
 *
 * Properties are declaration-only: nothing constructs these — they exist so
 * @nestjs/swagger can emit a response schema and generated clients get a typed
 * result instead of `Unit`/`void`.
 */
export class GeoJsonPointDto {
    @ApiProperty({ enum: ['Point'], example: 'Point' })
    type: 'Point';

    @ApiProperty({
        type: [Number],
        description: 'Position as [lon, lat] — GeoJSON order, not [lat, lon].',
        example: [103.85, 1.29],
    })
    coordinates: [number, number];
}

/**
 * Photon's per-feature attributes. Which keys are present depends on the
 * matched OSM object, so all are optional and unrecognised keys may appear.
 */
export class GeoJsonFeaturePropertiesDto {
    @ApiPropertyOptional({ description: 'OSM element id.' })
    osm_id?: number;

    @ApiPropertyOptional({ description: 'OSM element type: N, W or R.' })
    osm_type?: string;

    @ApiPropertyOptional({ description: 'OSM key, e.g. `place`, `amenity`.' })
    osm_key?: string;

    @ApiPropertyOptional({ description: 'OSM value, e.g. `city`, `fuel`.' })
    osm_value?: string;

    @ApiPropertyOptional({ description: 'Primary display name of the result.' })
    name?: string;

    @ApiPropertyOptional()
    housenumber?: string;

    @ApiPropertyOptional()
    street?: string;

    @ApiPropertyOptional()
    city?: string;

    @ApiPropertyOptional()
    district?: string;

    @ApiPropertyOptional()
    state?: string;

    @ApiPropertyOptional()
    postcode?: string;

    @ApiPropertyOptional()
    country?: string;

    @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2 country code.' })
    countrycode?: string;

    @ApiPropertyOptional({
        type: [Number],
        description: 'Bounding box as [minLon, minLat, maxLon, maxLat].',
    })
    extent?: number[];
}

export class GeoJsonFeatureDto {
    @ApiProperty({ enum: ['Feature'], example: 'Feature' })
    type: 'Feature';

    @ApiProperty({ type: GeoJsonPointDto })
    geometry: GeoJsonPointDto;

    @ApiProperty({ type: GeoJsonFeaturePropertiesDto })
    properties: GeoJsonFeaturePropertiesDto;
}

export class GeoJsonFeatureCollectionDto {
    @ApiProperty({ enum: ['FeatureCollection'], example: 'FeatureCollection' })
    type: 'FeatureCollection';

    @ApiProperty({ type: [GeoJsonFeatureDto] })
    features: GeoJsonFeatureDto[];
}
