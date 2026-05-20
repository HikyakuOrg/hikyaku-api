import { Entity, PrimaryColumn } from 'typeorm';

// Permission grants attached to an outstanding invitation. Copied into
// user_permission when the invitation is accepted.
@Entity('organisation_invitation_permissions')
export class OrganisationInvitationPermission {
    @PrimaryColumn({ name: 'invitation_id', type: 'uuid' })
    invitationId: string;

    @PrimaryColumn({ name: 'permission_id', type: 'bigint' })
    permissionId: number;
}
