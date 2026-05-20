import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type OrganisationInvitationStatus =
    | 'pending'
    | 'accepted'
    | 'declined'
    | 'revoked';

// Server-side record of an outstanding org invite. The recipient is identified
// by email (lowercased); the email link itself carries no token, so link
// scanners cannot consume the invitation.
@Entity('organisation_invitations')
export class OrganisationInvitation {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @Column({ type: 'text' })
    email: string;

    @Column({ name: 'role_id', type: 'bigint' })
    roleId: number;

    @Column({ name: 'invited_by_user_id', type: 'uuid' })
    invitedByUserId: string;

    @Column({ type: 'text', default: 'pending' })
    status: OrganisationInvitationStatus;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
    decidedAt: Date | null;
}
