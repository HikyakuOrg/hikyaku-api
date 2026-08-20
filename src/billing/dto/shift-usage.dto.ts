import { ApiProperty } from '@nestjs/swagger';
import type { ShiftUsageStatus } from '../billing.service';

/**
 * Swagger view of `ShiftUsageStatus` in `billing.service.ts`. The interface there
 * stays the source of truth; `implements` is what stops the two drifting — same
 * pairing as TrialStatusDto/TrialStatus.
 */

/** 200 body of GET /api/v1/billing/usage. */
export class ShiftUsageStatusDto implements ShiftUsageStatus {
    @ApiProperty({
        description: 'Shifts created by this organisation so far this calendar month.',
        example: 23,
    })
    shiftsUsedThisPeriod: number;

    @ApiProperty({
        description:
            'Shifts included before overage billing applies. PLACEHOLDER — see ' +
            'create-stripe-subscriptions.ps1 for the actual figure per org type.',
        example: 30,
    })
    freeAllowance: number;

    @ApiProperty({
        description:
            'Whether the organisation has a payment method on file. Once ' +
            '`shiftsUsedThisPeriod` reaches `freeAllowance`, further shift ' +
            'creation is blocked (HTTP 400 / check_violation) unless this is true.',
        example: false,
    })
    hasPaymentMethod: boolean;

    @ApiProperty({
        type: String,
        description: 'ISO 8601 instant the free allowance resets (start of next calendar month).',
        example: '2026-09-01T00:00:00.000Z',
    })
    periodEnd: string;
}
