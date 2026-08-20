import { ApiProperty } from '@nestjs/swagger';
import type { VanityUrlStatus } from '../billing.service';

/**
 * Swagger view of `VanityUrlStatus` in `billing.service.ts`. The interface
 * there stays the source of truth; `implements` is what stops the two
 * drifting — same pairing as TrialStatusDto/TrialStatus.
 */

/** 200 body of GET /api/v1/billing/vanity-url. */
export class VanityUrlStatusDto implements VanityUrlStatus {
    @ApiProperty({
        description:
            'Whether the organisation is currently entitled to a vanity ' +
            'booking subdomain (<vanity_slug>.hikyaku.org). True for a ' +
            'grandfathered company org unconditionally, otherwise mirrors the ' +
            "live vanity_url Stripe entitlement synced from that org's " +
            'Billing customer.',
        example: true,
    })
    hasVanityUrlEntitlement: boolean;
}
