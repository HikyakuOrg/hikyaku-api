import { HttpException } from '@nestjs/common';
import { VroomService } from './vroom.service';
import type { VroomRequest } from './vroom.types';

describe('VroomService', () => {
    let service: VroomService;
    let mockFetch: jest.Mock;
    const originalFetch = global.fetch;
    const originalVroomUrl = process.env.VROOM_URL;

    const request: VroomRequest = {
        jobs: [{ id: 1, service: 900, location: [151.2, -33.8], amount: [2000], priority: 50 }],
        vehicles: [{ id: 1, profile: 'auto', start: [151.0, -33.7], end: [151.0, -33.7], capacity: [5000] }],
    };

    beforeEach(() => {
        service = new VroomService();
        mockFetch = jest.fn();
        global.fetch = mockFetch as unknown as typeof fetch;
        process.env.VROOM_URL = 'http://vroom.test:3000';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        if (originalVroomUrl === undefined) {
            delete process.env.VROOM_URL;
        } else {
            process.env.VROOM_URL = originalVroomUrl;
        }
    });

    it('POSTs the request as JSON to VROOM_URL', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ code: 0, routes: [] }),
        });

        await service.solve(request);

        expect(mockFetch).toHaveBeenCalledWith('http://vroom.test:3000', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });
    });

    it('falls back to localhost when VROOM_URL is unset', async () => {
        delete process.env.VROOM_URL;
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ code: 0 }),
        });

        await service.solve(request);

        expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000');
    });

    it('returns the parsed optimization response on success', async () => {
        const response = {
            code: 0,
            summary: { cost: 100, routes: 1, unassigned: 0 },
            routes: [{ vehicle: 1, steps: [] }],
        };
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(response),
        });

        await expect(service.solve(request)).resolves.toEqual(response);
    });

    it('throws an HttpException carrying status and body on error', async () => {
        const errorBody = { code: 2, error: 'Input error: invalid vehicle profile' };
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: () => Promise.resolve(errorBody),
        });

        const promise = service.solve(request);
        await expect(promise).rejects.toBeInstanceOf(HttpException);
        await promise.catch((err: HttpException) => {
            expect(err.getStatus()).toBe(400);
            expect(err.getResponse()).toEqual(errorBody);
        });
    });
});
