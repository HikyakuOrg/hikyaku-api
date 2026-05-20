import { Entity, PrimaryColumn } from 'typeorm';

// Org-scoped permission grant. The org creator is granted every permission
// for their organisation (see OrganisationsService.signup).
@Entity('user_permission')
export class UserPermission {
    @PrimaryColumn({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @PrimaryColumn({ name: 'user_id', type: 'uuid' })
    userId: string;

    @PrimaryColumn({ name: 'permission_id', type: 'bigint' })
    permissionId: number;
}
