import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// A membership row: one (organisation, user) pair with a role. A user can be a
// member of many organisations with a different role in each.
@Entity('team_members')
export class TeamMember {
    @PrimaryColumn({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    @PrimaryColumn({ type: 'uuid' })
    id: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @Column({ name: 'role_id', type: 'bigint' })
    roleId: number;
}
