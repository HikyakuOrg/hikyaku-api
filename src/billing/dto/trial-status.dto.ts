import { ApiProperty } from '@nestjs/swagger';
import type { TrialState } from 'src/common/trial';
import type { TrialStatus } from '../billing.service';

/**
 * Swagger view of `TrialStatus` in `billing.service.ts`. The interface there stays
 * the source of truth; `implements` is what stops the two drifting.
 */

/** 200 body of GET /api/v1/billing/trial. */
export class TrialStatusDto implements TrialStatus {
    @ApiProperty({
        enum: ['none', 'active', 'expired'],
        description:
            '`none` — no trial applies to this organisation, which is the case ' +
            'for personal orgs and for orgs created before trials existed. They ' +
            'are unrestricted, NOT expired. `active` — trial running. `expired` — ' +
            'the deadline has passed and tenant-scoped endpoints answer 402.',
        example: 'active',
    })
    state: TrialState;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'ISO 8601 instant the trial ends, or null when `state` is `none`. ' +
            'Returned raw so the dashboard can render it in the viewer’s locale.',
        example: '2026-08-22T04:12:57.000Z',
    })
    trialEndsAt: string | null;

    @ApiProperty({
        type: Number,
        nullable: true,
        description:
            'Whole days remaining, floored — so the final day reads 0, not 1. ' +
            'Null when `state` is `none`, and 0 rather than negative once expired.',
        example: 6,
    })
    daysRemaining: number | null;
}
