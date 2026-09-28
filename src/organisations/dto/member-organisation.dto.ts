import { ApiProperty } from '@nestjs/swagger';
import type { MemberOrganisation } from '../organisations.service';

/**
 * One entry of GET /api/v1/organisations/me. `MemberOrganisation` stays the
 * source of truth; `implements` keeps the two in sync.
 */
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
        description: 'NULL for an unnamed personal organisation.',
        example: 'Acme Logistics',
    })
    name: string | null;

    @ApiProperty({ enum: ['personal', 'company'], example: 'company' })
    orgType: string;
}
