import { Entity, PrimaryColumn } from 'typeorm';

@Entity('role_permission')
export class RolePermission {
    @PrimaryColumn({ name: 'role_id', type: 'bigint' })
    roleId: number;

    @PrimaryColumn({ name: 'permission_id', type: 'bigint' })
    permissionId: number;
}
