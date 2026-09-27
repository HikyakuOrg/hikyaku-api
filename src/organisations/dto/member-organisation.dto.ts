import { ApiProperty } from '@nestjs/swagger';
import type { MemberOrganisation } from '../organisations.service';

/**
 * Swagger view of `MemberOrganisation` in `organisations.service.ts`. The
 * interface there stays the source of truth; `implements` is what stops the
 * two drifting.
 */

/** One entry of GET /api/v1/organisations/me. */
export class MemberOrganisationDto implements MemberOrganisation {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({
        description:
            'Send this as `X-Organisation-Slug` on tenant-scoped calls.',
        example: 'acme-logistics',
    })
    slug: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'NULL for a personal organisation that was never named.',
        example: 'Acme Logistics',
    })
    name: string | null;

    @ApiProperty({ enum: ['personal', 'company'], example: 'company' })
    orgType: string;
}
