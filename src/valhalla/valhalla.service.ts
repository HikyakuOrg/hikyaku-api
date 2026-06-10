import { Injectable, HttpException } from '@nestjs/common';
import type { ValhallaRouteResponse } from './valhalla.types';

/**
 * Thin client for the self-hosted Valhalla routing engine.
 */
@Injectable()
export class ValhallaService {
    /**
     * Returns the driving distance in kilometers along the route visiting
     * `coordinates` ([lon, lat] pairs) in order.
     */
    async routeDistanceKm(coordinates: number[][]): Promise<number> {
        const baseUrl = process.env.VALHALLA_URL ?? 'http://localhost:8002';

        const response = await fetch(`${baseUrl}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locations: coordinates.map(([lon, lat]) => ({ lat, lon, type: 'break' })),
                costing: 'auto',
                units: 'kilometers',
                directions_type: 'none',
            }),
        });

        const data: unknown = await response.json();
        if (!response.ok) {
            throw new HttpException(data as object, response.status);
        }
        return (data as ValhallaRouteResponse).trip.summary.length;
    }
}
