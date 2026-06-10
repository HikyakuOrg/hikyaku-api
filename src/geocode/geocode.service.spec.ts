import { HttpException } from '@nestjs/common';
import { GeocodeService } from './geocode.service';

describe('GeocodeService', () => {
    let service: GeocodeService;
    let mockFetch: jest.Mock;
    const originalFetch = global.fetch;
    const originalBaseUrl = process.env.PELIAS_BASE_URL;
    const originalApiKey = process.env.PELIAS_API_KEY;

    beforeEach(() => {
        service = new GeocodeService();
        mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ type: 'FeatureCollection', features: [] }),
        });
        global.fetch = mockFetch as unknown as typeof fetch;
        process.env.PELIAS_BASE_URL = 'http://pelias.test/v1';
        process.env.PELIAS_API_KEY = 'pelias-key';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalBaseUrl === undefined) delete process.env.PELIAS_BASE_URL;
        else process.env.PELIAS_BASE_URL = originalBaseUrl;
        if (originalApiKey === undefined) delete process.env.PELIAS_API_KEY;
        else process.env.PELIAS_API_KEY = originalApiKey;
    });

    it('enriches the query string with the PELIAS_API_KEY', async () => {
        await service.get('/autocomplete', { text: 'sydney' });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain('http://pelias.test/v1/autocomplete?');
        expect(url).toContain('api_key=pelias-key');
        expect(url).toContain('text=sydney');
    });

    it('omits undefined query params and serializes array params', async () => {
        await service.get('/search', {
            text: 'melbourne',
            layers: ['address', 'venue'],
            missing: undefined,
        });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain('layers=address');
        expect(url).toContain('layers=venue');
        expect(url).not.toContain('missing');
    });

    it('forwards the Authorization header when provided', async () => {
        await service.get('/reverse', { 'point.lat': '-33.8' }, 'Bearer token-1');

        const init = mockFetch.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token-1');
    });

    it('throws an HttpException carrying status and body on error', async () => {
        const errorBody = { error: 'invalid api key' };
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 403,
            json: () => Promise.resolve(errorBody),
        });

        const promise = service.get('/search', { text: 'x' });
        await expect(promise).rejects.toBeInstanceOf(HttpException);
        await promise.catch((err: HttpException) => {
            expect(err.getStatus()).toBe(403);
            expect(err.getResponse()).toEqual(errorBody);
        });
    });
});
