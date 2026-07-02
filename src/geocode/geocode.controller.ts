import { Controller, Get, Query, Headers, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { GeocodeService } from './geocode.service';

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

@UseGuards(AuthGuard)
@Controller('geocode')
export class GeocodeController {
    constructor(private readonly geocodeService: GeocodeService) { }

    /**
     * Forward Geocode – text search returning a list of location objects.
     * Photon serves search and autocomplete from the same `/api` endpoint.
     */
    @Get('search')
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
    reverse(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        return this.geocodeService.get('/reverse', toPhotonReverseQuery(query), auth);
    }
}
