import {
    applyDecorators,
    Controller,
    Get,
    Query,
    Headers,
    UseGuards,
} from '@nestjs/common';
import {
    ApiHeader,
    ApiOkResponse,
    ApiQuery,
    ApiSecurity,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { GeocodeService } from './geocode.service';
import { GeoJsonFeatureCollectionDto } from './dto/geo-json.dto';

/**
 * Query params common to the two forward-search endpoints. Declared as
 * decorators rather than a DTO because the handlers forward the whole query
 * object to Photon verbatim — a validated DTO would strip any param not listed
 * here, which would silently break Photon features as they are adopted.
 */
/**
 * Declared explicitly so the generated param is optional. The `@Headers()`
 * decorator on the handler would otherwise emit a required `authorization`
 * header, which reads as this endpoint's authentication — it is not; that is
 * `x-whendan`. This header is only a pass-through to the upstream geocoder.
 */
const PhotonAuthPassthroughHeader = ApiHeader({
    name: 'authorization',
    required: false,
    description:
        'Optional; forwarded verbatim to the upstream geocoder. This is NOT this ' +
        'endpoint`s own authentication — that is the `x-whendan` header.',
});

const ForwardSearchQueryParams = [
    PhotonAuthPassthroughHeader,
    ApiQuery({
        name: 'text',
        required: true,
        type: String,
        description: 'Free-text search string. Mapped onto Photon`s `q` param.',
        example: 'Marina Bay Sands',
    }),
    ApiQuery({
        name: 'limit',
        required: false,
        type: Number,
        description: 'Maximum number of features to return.',
    }),
    ApiQuery({
        name: 'lang',
        required: false,
        type: String,
        description: 'Preferred language for names, e.g. `en`.',
    }),
    ApiQuery({
        name: 'layer',
        required: false,
        type: String,
        isArray: true,
        description:
            'Restrict results to given Photon layers, e.g. `house`, `street`, `city`.',
    }),
];

/** Map the public `text` param onto Photon's forward-search param `q`. */
function toPhotonSearchQuery(
    query: Record<string, string>,
): Record<string, string | undefined> {
    const { text, q, ...rest } = query;
    return { q: text ?? q, ...rest };
}

/** Map the public `point.lat`/`point.lon` params onto Photon's `lat`/`lon`. */
function toPhotonReverseQuery(
    query: Record<string, string>,
): Record<string, string | undefined> {
    const { 'point.lat': pointLat, 'point.lon': pointLon, ...rest } = query;
    return { lat: pointLat ?? rest.lat, lon: pointLon ?? rest.lon, ...rest };
}

@ApiTags('geocode')
@ApiSecurity('whendanToken')
@ApiUnauthorizedResponse({
    description: 'Missing or invalid `x-whendan` header.',
})
@UseGuards(AuthGuard)
@Controller('geocode')
export class GeocodeController {
    constructor(private readonly geocodeService: GeocodeService) { }

    /**
     * Forward Geocode – text search returning a list of location objects.
     * Photon serves search and autocomplete from the same `/api` endpoint.
     */
    @Get('search')
    @applyDecorators(...ForwardSearchQueryParams)
    @ApiOkResponse({ type: GeoJsonFeatureCollectionDto })
    search(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        return this.geocodeService.get('/api', toPhotonSearchQuery(query), auth);
    }

    /**
     * Geocode Autocomplete – returns suggestions as the user types. Photon's
     * `/api` endpoint is autocomplete-oriented, so this shares it with search.
     */
    @Get('autocomplete')
    @applyDecorators(...ForwardSearchQueryParams)
    @ApiOkResponse({ type: GeoJsonFeatureCollectionDto })
    autocomplete(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        return this.geocodeService.get('/api', toPhotonSearchQuery(query), auth);
    }

    /**
     * Reverse Geocode Service – resolve coordinates to an address.
     * Accepts `point.lat`/`point.lon` (or native `lat`/`lon`).
     */
    @Get('reverse')
    @PhotonAuthPassthroughHeader
    @ApiQuery({
        name: 'lat',
        required: true,
        type: Number,
        description: 'Latitude to resolve. `point.lat` is accepted as an alias.',
        example: 1.2834,
    })
    @ApiQuery({
        name: 'lon',
        required: true,
        type: Number,
        description: 'Longitude to resolve. `point.lon` is accepted as an alias.',
        example: 103.8607,
    })
    @ApiQuery({
        name: 'radius',
        required: false,
        type: Number,
        description: 'Search radius in kilometres.',
    })
    @ApiQuery({
        name: 'include',
        required: false,
        type: String,
        description: 'Restrict results to a category, e.g. `osm.amenity.fuel`.',
    })
    @ApiQuery({
        name: 'limit',
        required: false,
        type: Number,
        description: 'Maximum number of features to return.',
    })
    @ApiOkResponse({ type: GeoJsonFeatureCollectionDto })
    reverse(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        return this.geocodeService.get('/reverse', toPhotonReverseQuery(query), auth);
    }
}
