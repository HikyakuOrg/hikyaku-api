import { HttpException } from '@nestjs/common';
import { GeocodeService } from './geocode.service';

describe('GeocodeService', () => {
    let service: GeocodeService;
    let mockFetch: jest.Mock;
    const originalFetch = global.fetch;
    const originalBaseUrl = process.env.PHOTON_URL;

    beforeEach(() => {
        service = new GeocodeService();
        mockFetch = jest.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ type: 'FeatureCollection', features: [] }),
        });
        global.fetch = mockFetch as unknown as typeof fetch;
        process.env.PHOTON_URL = 'http://photon.test';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalBaseUrl === undefined) delete process.env.PHOTON_URL;
        else process.env.PHOTON_URL = originalBaseUrl;
    });

    it('builds an absolute Photon URL and adds no api_key', async () => {
        await service.get('/api', { q: 'sydney' });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain('http://photon.test/api?');
        expect(url).toContain('q=sydney');
        expect(url).not.toContain('api_key');
    });

    it('omits undefined query params and serializes array params', async () => {
        await service.get('/api', {
            q: 'melbourne',
            layer: ['house', 'street'],
            missing: undefined,
        });

        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain('layer=house');
        expect(url).toContain('layer=street');
        expect(url).not.toContain('missing');
    });

    it('throws a 500 when PHOTON_URL is unset instead of building a relative URL', async () => {
        delete process.env.PHOTON_URL;

        const promise = service.get('/api', { q: 'x' });
        await expect(promise).rejects.toBeInstanceOf(HttpException);
        await promise.catch((err: HttpException) => expect(err.getStatus()).toBe(500));
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('forwards the Authorization header when provided', async () => {
        await service.get('/reverse', { lat: '-33.8', lon: '151.2' }, 'Bearer token-1');

        const init = mockFetch.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer token-1');
    });

    it('throws an HttpException carrying status and body on error', async () => {
        const errorBody = { message: 'bad request' };
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: () => Promise.resolve(errorBody),
        });

        const promise = service.get('/api', { q: 'x' });
        await expect(promise).rejects.toBeInstanceOf(HttpException);
        await promise.catch((err: HttpException) => {
            expect(err.getStatus()).toBe(400);
            expect(err.getResponse()).toEqual(errorBody);
        });
    });
});
