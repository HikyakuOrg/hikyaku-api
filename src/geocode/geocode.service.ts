import { Injectable, HttpException } from '@nestjs/common';

/**
 * Proxy for the Pelias geocoder configured via PELIAS_BASE_URL /
 * PELIAS_API_KEY.
 */
@Injectable()
export class GeocodeService {
    async get(
        path: string,
        query: Record<string, string | string[] | undefined>,
        authHeader?: string,
    ): Promise<unknown> {
        const params = new URLSearchParams();
        const enrichedQuery = { api_key: process.env.PELIAS_API_KEY ?? '', ...query };
        for (const [key, value] of Object.entries(enrichedQuery)) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                value.forEach((v) => params.append(key, v));
            } else {
                params.set(key, value);
            }
        }
        const qs = params.toString();
        const url = `${process.env.PELIAS_BASE_URL ?? ''}${path}${qs ? `?${qs}` : ''}`;

        const headers: Record<string, string> = {
            Accept: 'application/json, application/geo+json, */*',
        };
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }

        const response = await fetch(url, { method: 'GET', headers });
        const data: unknown = await response.json();
        if (!response.ok) {
            throw new HttpException(data as object, response.status);
        }
        return data;
    }
}
