import { Injectable, HttpException } from '@nestjs/common';

@Injectable()
export class OrsService {
    private readonly baseUrl: string;

    constructor() {
        this.baseUrl = process.env.ORS_BASE_URL ?? 'https://api.openrouteservice.org';
    }

    async proxyPost(
        path: string,
        body: object,
        authHeader?: string,
        baseUrl?: string,
    ): Promise<unknown> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json, application/geo+json, */*',
        };
        if (authHeader) {
            headers['Authorization'] = authHeader;
        }

        const response = await fetch(`${baseUrl ?? this.baseUrl}${path}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        const data: unknown = await response.json();
        if (!response.ok) {
            throw new HttpException(data as object, response.status);
        }
        return data;
    }

    async proxyGet(
        path: string,
        query: Record<string, string | string[] | undefined>,
        authHeader?: string,
        baseUrl?: string,
    ): Promise<unknown> {
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
        const url = `${baseUrl ?? this.baseUrl}${path}${qs ? `?${qs}` : ''}`;

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
