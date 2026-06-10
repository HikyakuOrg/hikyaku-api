import { HttpException } from '@nestjs/common';
import { ValhallaService } from './valhalla.service';

describe('ValhallaService', () => {
    let service: ValhallaService;
    let mockFetch: jest.Mock;
    const originalFetch = global.fetch;
    const originalValhallaUrl = process.env.VALHALLA_URL;

    beforeEach(() => {
        service = new ValhallaService();
        mockFetch = jest.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
        process.env.VALHALLA_URL = 'http://valhalla.test:8002';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalValhallaUrl === undefined) {
            delete process.env.VALHALLA_URL;
        } else {
            process.env.VALHALLA_URL = originalValhallaUrl;
        }
    });

    it('POSTs [lon, lat] pairs as {lat, lon} break locations with auto costing in km', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ trip: { summary: { time: 600, length: 12.345 }, legs: [] } }),
        });

        await service.routeDistanceKm([
            [151.0, -33.7],
            [151.2, -33.8],
        ]);

        expect(mockFetch).toHaveBeenCalledWith('http://valhalla.test:8002/route', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locations: [
                    { lat: -33.7, lon: 151.0, type: 'break' },
                    { lat: -33.8, lon: 151.2, type: 'break' },
                ],
                costing: 'auto',
                units: 'kilometers',
                directions_type: 'none',
            }),
        });
    });

    it('returns trip.summary.length (kilometers)', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ trip: { summary: { time: 600, length: 12.345 }, legs: [] } }),
        });

        await expect(
            service.routeDistanceKm([
                [151.0, -33.7],
                [151.2, -33.8],
            ]),
        ).resolves.toBe(12.345);
    });

    it('throws an HttpException carrying status and body on error', async () => {
        const errorBody = { error: 'No path could be found for input', error_code: 442, status_code: 400 };
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: () => Promise.resolve(errorBody),
        });

        const promise = service.routeDistanceKm([
            [151.0, -33.7],
            [151.2, -33.8],
        ]);
        await expect(promise).rejects.toBeInstanceOf(HttpException);
        await promise.catch((err: HttpException) => {
            expect(err.getStatus()).toBe(400);
            expect(err.getResponse()).toEqual(errorBody);
        });
    });
});
