import { Controller, Get, Query, Headers, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { GeocodeService } from './geocode.service';

//@UseGuards(AuthGuard)
@Controller('geocode')
export class GeocodeController {
    constructor(private readonly geocodeService: GeocodeService) { }

    /**
     * Forward Geocode Service – text search returning a list of location objects.
     */
    @Get('search')
    search(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        return this.geocodeService.get('/search', query, auth);
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
        return this.geocodeService.get('/search/structured', query, auth);
    }

    /**
     * Geocode Autocomplete – returns suggestions as the user types.
     */
    @Get('autocomplete')
    autocomplete(
        @Query() query: Record<string, string>,
        @Headers('authorization') auth?: string,
    ): Promise<unknown> {
        return this.geocodeService.get('/autocomplete', query, auth);
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
        return this.geocodeService.get('/reverse', query, auth);
    }
}
