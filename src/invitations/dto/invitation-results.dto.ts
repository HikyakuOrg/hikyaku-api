import { ApiProperty } from '@nestjs/swagger';
import type {
    AcceptInvitationResult,
    CreateInvitationResult,
    PendingInvitation,
} from '../invitations.service';

/**
 * Swagger view of the results in `invitations.service.ts`. The interfaces there
 * stay the source of truth; `implements` is what stops the two drifting.
 */

/** 201 body of POST /api/v1/invitations. */
export class CreateInvitationResultDto implements CreateInvitationResult {
    @ApiProperty({
        format: 'uuid',
        description:
            'The invitation row. Re-inviting an address that already has an ' +
            'outstanding invitation updates that one and returns its existing id ' +
            'rather than creating a second.',
    })
    id: string;

    @ApiProperty({
        format: 'email',
        description: 'Lower-cased — compare case-insensitively against the request.',
    })
    email: string;

    @ApiProperty({
        enum: ['pending'],
        description:
            'Always `pending`: the invitation exists but has not been acted on. ' +
            'The email is sent best-effort afterwards, so a 201 does not confirm ' +
            'delivery.',
        example: 'pending',
    })
    status: 'pending';
}

/** The organisation a pending invitation is for. */
export class InvitationOrganisationDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'acme-logistics' })
    slug: string;

    @ApiProperty({ example: 'Acme Logistics' })
    name: string;
}

/** One entry of GET /api/v1/invitations/pending. */
export class PendingInvitationDto implements PendingInvitation {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ format: 'date-time' })
    created_at: string;

    @ApiProperty({ type: InvitationOrganisationDto })
    organisation: InvitationOrganisationDto;

    @ApiProperty({
        description: 'Role the invitee is granted on acceptance.',
        example: 'Driver',
    })
    role: string;

    @ApiProperty({
        type: [String],
        description:
            'Permissions granted alongside the role. Empty when the invitation ' +
            'carries none.',
        example: ['team_members.view', 'vehicles.view'],
    })
    permissions: string[];
}

/** 200 body of POST /api/v1/invitations/{id}/accept. */
export class AcceptInvitationResultDto implements AcceptInvitationResult {
    @ApiProperty({ format: 'uuid' })
    organisation_id: string;

    @ApiProperty({
        description:
            'Slug of the joined organisation — switch the active tenant to it. ' +
            'Empty string in the unlikely case the organisation row has since ' +
            'gone.',
        example: 'acme-logistics',
    })
    organisation_slug: string;
}

/** 200 body of POST /api/v1/invitations/{id}/decline. */
export class DeclineInvitationResultDto {
    @ApiProperty({
        enum: [true],
        description:
            'Always true — a failure to decline surfaces as a 404, never as ' +
            '`false`.',
        example: true,
    })
    ok: boolean;
}
