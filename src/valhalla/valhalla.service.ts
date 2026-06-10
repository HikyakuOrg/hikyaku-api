import { Injectable, HttpException } from '@nestjs/common';
import { orsProfileToValhallaCosting } from 'src/vroom/profile-map';
import { decodePolyline } from './polyline';
import type { RouteLeg, RoutePreview } from './route-preview.types';
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

    /**
     * Routes through `coordinates` ([lng, lat] pairs) in order for the given
     * vehicle `profile` (an ORS-style profile, e.g. 'driving-car') and returns a
     * normalised RoutePreview — coordinates in [lng, lat], durations in seconds,
     * distances in meters.
     */
    async route(profile: string, coordinates: [number, number][]): Promise<RoutePreview> {
        const baseUrl = process.env.VALHALLA_URL ?? 'http://localhost:8002';

        const response = await fetch(`${baseUrl}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locations: coordinates.map(([lng, lat]) => ({ lat, lon: lng, type: 'break' })),
                costing: orsProfileToValhallaCosting(profile),
                units: 'kilometers',
                directions_type: 'none',
            }),
        });

        const data: unknown = await response.json();
        if (!response.ok) {
            throw new HttpException(data as object, response.status);
        }

        const { trip } = data as ValhallaRouteResponse;

        const points: [number, number][] = [];
        const wayPoints: number[] = [0];
        const legs: RouteLeg[] = [];

        for (const leg of trip.legs) {
            // Valhalla shapes are encoded with 6-digit precision (not the usual 5).
            const legCoords = decodePolyline(leg.shape, 1e6);
            // Consecutive legs share their boundary vertex — drop the duplicate.
            points.push(...(points.length > 0 ? legCoords.slice(1) : legCoords));
            wayPoints.push(points.length - 1);
            legs.push({
                duration: leg.summary.time,
                distance: leg.summary.length * 1000,
            });
        }

        return {
            coordinates: points,
            wayPoints,
            legs,
            summary: {
                duration: trip.summary.time,
                distance: trip.summary.length * 1000,
            },
        };
    }
}
