import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

/**
 * Proxy for the Photon geocoder configured via PHOTON_URL.
 *
 * Photon needs no API key and serves autocomplete/forward search from the
 * single `/api` endpoint and reverse geocoding from `/reverse`. `path` is a
 * Photon path (e.g. `/api`, `/reverse`); `query` is passed through verbatim,
 * so callers are responsible for using Photon's parameter names (`q`, `lat`,
 * `lon`, …).
 */
@Injectable()
export class GeocodeService {
    async get(
        path: string,
        query: Record<string, string | string[] | undefined>,
    ): Promise<unknown> {
        const baseUrl = process.env.PHOTON_URL;
        if (!baseUrl) {
            throw new HttpException(
                'Geocoder is not configured (PHOTON_URL is unset)',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }

        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                value.forEach((v) => params.append(key, v));
            } else {
                params.set(key, value);
            }
        }
        const qs = params.toString();
        const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;

        const headers: Record<string, string> = {
            Accept: 'application/json, application/geo+json, */*',
        };

        const response = await fetch(url, { method: 'GET', headers });
        const data: unknown = await response.json();
        if (!response.ok) {
            throw new HttpException(data as object, response.status);
        }
        return data;
    }
}
