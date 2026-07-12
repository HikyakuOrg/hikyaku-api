import { Injectable, HttpException } from '@nestjs/common';
import type { OptimizationResponse, VroomRequest } from './vroom.types';

/**
 * Thin client for the VROOM solver (vroom-express), which accepts the
 * optimization request as a POST to its root path. VROOM itself is configured
 * (vroom-conf/config.yml) to resolve travel times via the Valhalla router.
 */
@Injectable()
export class VroomService {
    async solve(request: VroomRequest): Promise<OptimizationResponse> {
        const url = process.env.VROOM_URL ?? 'http://localhost:3000';

        // Force the solver on (plan mode -c off). The deployed vroom-express may
        // default to plan mode, which never assigns jobs and returns everything
        // unassigned; `override: true` in vroom-conf lets us disable it here so
        // the API is correct regardless of the server's default.
        const body: VroomRequest = {
            ...request,
            options: { c: false, ...request.options },
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const data: unknown = await response.json();
        if (!response.ok) {
            throw new HttpException(data as object, response.status);
        }
        return data as OptimizationResponse;
    }
}
