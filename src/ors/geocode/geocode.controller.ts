import { Controller, Get, Query, Headers, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/guards/auth.guard';
import { OrsService } from '../ors.service';

//@UseGuards(AuthGuard)
@Controller('geocode')
export class GeocodeController {
    constructor(private readonly orsService: OrsService) { }

    /**
     * Forward Geocode Service – text search returning a list of location objects.
     * Pass `api_key` as a query parameter when using the public ORS API.
     */
    @Get('search')
    search(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        const enrichedQuery = { api_key: process.env.PELIAS_API_KEY ?? '', ...query };
        return this.orsService.proxyGet('/search', enrichedQuery, auth, process.env.PELIAS_BASE_URL);
    }

    /**
     * Structured Forward Geocode Service (beta) – search by individual address
     * components (address, city, country, postal code, …).
     */
    @Get('search/structured')
    searchStructured(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        const enrichedQuery = { api_key: process.env.PELIAS_API_KEY ?? '', ...query };
        return this.orsService.proxyGet('/search/structured', enrichedQuery, auth, process.env.PELIAS_BASE_URL);
    }

    /**
     * Geocode Autocomplete – returns suggestions as the user types.
     */
    @Get('autocomplete')
    autocomplete(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        const enrichedQuery = { api_key: process.env.PELIAS_API_KEY ?? '', ...query };
        return this.orsService.proxyGet('/autocomplete', enrichedQuery, auth, process.env.PELIAS_BASE_URL);
    }

    /**
     * Reverse Geocode Service – resolve coordinates to an address.
     * Required query params: `point.lon`, `point.lat`.
     */
    @Get('reverse')
    reverse(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        const enrichedQuery = { api_key: process.env.PELIAS_API_KEY ?? '', ...query };
        return this.orsService.proxyGet('/reverse', enrichedQuery, auth, process.env.PELIAS_BASE_URL);
    }
}
