import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SupabaseClient } from '@supabase/supabase-js';
import { In, Repository } from 'typeorm';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { DatabaseService } from 'src/database/database.service';
import { AppPermission } from 'src/entities/app-permission.entity';
import { AppRole } from 'src/entities/app-role.entity';
import { OrganisationInvitation } from 'src/entities/organisation-invitation.entity';
import { OrganisationInvitationPermission } from 'src/entities/organisation-invitation-permission.entity';
import { TeamMember } from 'src/entities/team-member.entity';
import { UserPermission } from 'src/entities/user-permission.entity';
import { MailerService } from 'src/mailer/mailer.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';

export interface CreateInvitationResult {
    id: string;
    email: string;
    status: 'pending';
}

export interface PendingInvitation {
    id: string;
    created_at: string;
    organisation: { id: string; slug: string; name: string };
    role: string;
    permissions: string[];
}

export interface AcceptInvitationResult {
    organisation_id: string;
    organisation_slug: string;
}

@Injectable()
export class InvitationsService {
    private readonly logger = new Logger(InvitationsService.name);

    constructor(
        @Inject(SUPABASE_CLIENT)
        private readonly supabase: SupabaseClient,
        private readonly db: DatabaseService,
        @InjectRepository(AppRole)
        private readonly appRoleRepo: Repository<AppRole>,
        @InjectRepository(AppPermission)
        private readonly appPermissionRepo: Repository<AppPermission>,
        @InjectRepository(UserPermission)
        private readonly userPermissionRepo: Repository<UserPermission>,
        private readonly mailer: MailerService,
    ) { }

    async createInvitation(
        dto: CreateInvitationDto,
        caller: { id: string; email: string },
        organisationId: string,
    ): Promise<CreateInvitationResult> {
        // 1. Body org_id must match the org resolved from X-Organisation-Slug.
        if (dto.org_id !== organisationId) {
            throw new BadRequestException(
                'org_id does not match the active organisation',
            );
        }

        const inviteEmail = dto.user_email.toLowerCase();

        // 2. Self-invite guard.
        if (caller.email && inviteEmail === caller.email.toLowerCase()) {
            throw new BadRequestException('You cannot invite yourself');
        }

        // 3. Role lookup.
        const role = await this.appRoleRepo.findOne({
            where: { name: dto.role },
            select: { id: true, name: true },
        });
        if (!role) {
            throw new BadRequestException(`Role "${dto.role}" does not exist`);
        }

        // 4. Validate permissions exist.
        const uniquePermissions = [...new Set(dto.permissions ?? [])];
        let permissionIds: number[] = [];
        if (uniquePermissions.length > 0) {
            const permRows = await this.appPermissionRepo.findBy({
                permission: In(uniquePermissions),
            });
            if (permRows.length !== uniquePermissions.length) {
                const found = new Set(permRows.map((r) => r.permission));
                const missing = uniquePermissions.filter((p) => !found.has(p));
                throw new BadRequestException(
                    `Unknown permission(s): ${missing.join(', ')}`,
                );
            }
            permissionIds = permRows.map((r) => r.id);
        }

        // 5. Least-privilege: caller cannot grant permissions they do not hold.
        if (permissionIds.length > 0) {
            const callerGrants = await this.userPermissionRepo.findBy({
                organisationId,
                userId: caller.id,
            });
            const callerPermissionIds = new Set(
                callerGrants.map((g) => Number(g.permissionId)),
            );
            const missing = permissionIds.filter(
                (id) => !callerPermissionIds.has(Number(id)),
            );
            if (missing.length > 0) {
                throw new ForbiddenException(
                    'You cannot grant permissions you do not hold',
                );
            }
        }

        // 6. Resolve org name for the email (and confirm the org exists).
        const orgRows = await this.db.query<{ name: string }>(
            `SELECT name FROM organisations WHERE id = $1`,
            [organisationId],
        );
        if (orgRows.length === 0) {
            throw new NotFoundException('Organisation not found');
        }
        const orgName = orgRows[0].name;

        // 7. Already-a-member check — resolve invitee's user id via auth.users
        //    by email (case-insensitive), then look up team_members.
        const memberRows = await this.db.query<{ id: string }>(
            `SELECT tm.id
               FROM team_members tm
               JOIN auth.users u ON u.id = tm.id
              WHERE tm.organisation_id = $1
                AND lower(u.email) = $2
              LIMIT 1`,
            [organisationId, inviteEmail],
        );
        if (memberRows.length > 0) {
            throw new ConflictException(
                'This user is already a member of the organisation',
            );
        }

        // 8. Upsert the invitation + permission rows in a single transaction.
        const runner = await this.db.beginTransaction();
        let invitationId: string;
        try {
            // The partial unique index (organisation_id, email) WHERE status='pending'
            // means a second outstanding invite for the same (org, email) is rejected
            // by the DB. We catch that case and update the existing row instead.
            const existing = await runner.manager.findOne(OrganisationInvitation, {
                where: {
                    organisationId,
                    email: inviteEmail,
                    status: 'pending',
                },
            });

            if (existing) {
                invitationId = existing.id;
                await runner.manager.update(
                    OrganisationInvitation,
                    { id: invitationId },
                    {
                        roleId: role.id,
                        invitedByUserId: caller.id,
                    },
                );
                await runner.manager.delete(OrganisationInvitationPermission, {
                    invitationId,
                });
            } else {
                const inserted = await runner.manager.insert(
                    OrganisationInvitation,
                    {
                        organisationId,
                        email: inviteEmail,
                        roleId: role.id,
                        invitedByUserId: caller.id,
                        status: 'pending',
                    },
                );
                invitationId = inserted.identifiers[0].id as string;
            }

            if (permissionIds.length > 0) {
                await runner.manager.insert(
                    OrganisationInvitationPermission,
                    permissionIds.map((pid) => ({
                        invitationId,
                        permissionId: pid,
                    })),
                );
            }

            await runner.commitTransaction();
        } catch (dbError) {
            await runner.rollbackTransaction();
            const msg = (dbError as Error).message ?? String(dbError);
            throw new InternalServerErrorException(
                `Failed to persist invitation: ${msg}`,
            );
        } finally {
            await runner.release();
        }

        // 9. Send the email — best-effort, outside the transaction. The invitation
        //    row is the source of truth; a missed email can be re-sent later.
        const loginUrl = `${process.env.APP_URL ?? ''}/auth/login`;
        try {
            await this.mailer.sendInvitationEmail(dto.user_email, orgName, loginUrl);
        } catch (mailError) {
            this.logger.error(
                `Mail send failed for invitation ${invitationId}: ${(mailError as Error).message}`,
            );
        }

        return { id: invitationId, email: inviteEmail, status: 'pending' };
    }

    async listPendingFor(email: string): Promise<PendingInvitation[]> {
        // The email column is constrained lowercase; comparing with lower($1)
        // lets the partial index on (email) WHERE status='pending' be used.
        const rows = await this.db.query<{
            id: string;
            created_at: string;
            org_id: string;
            org_slug: string;
            org_name: string;
            role: string;
            permissions: string[] | null;
        }>(
            `SELECT i.id,
                    i.created_at,
                    o.id   AS org_id,
                    o.slug AS org_slug,
                    o.name AS org_name,
                    r.name AS role,
                    COALESCE(
                        ARRAY_REMOVE(ARRAY_AGG(p.permission), NULL),
                        ARRAY[]::text[]
                    ) AS permissions
               FROM organisation_invitations i
               JOIN organisations o ON o.id = i.organisation_id
               JOIN app_roles     r ON r.id = i.role_id
          LEFT JOIN organisation_invitation_permissions ip ON ip.invitation_id = i.id
          LEFT JOIN app_permission p ON p.id = ip.permission_id
              WHERE i.email = lower($1)
                AND i.status = 'pending'
              GROUP BY i.id, o.id, r.name
              ORDER BY i.created_at DESC`,
            [email],
        );

        return rows.map((row) => ({
            id: row.id,
            created_at: row.created_at,
            organisation: {
                id: row.org_id,
                slug: row.org_slug,
                name: row.org_name,
            },
            role: row.role,
            permissions: row.permissions ?? [],
        }));
    }

    async accept(
        id: string,
        user: { id: string; email: string; email_confirmed_at?: string | null },
    ): Promise<AcceptInvitationResult> {
        if (!user.email_confirmed_at) {
            throw new ForbiddenException(
                'Verify your email address before accepting the invitation',
            );
        }

        const runner = await this.db.beginTransaction();
        try {
            // Atomic claim — only succeeds if invitation is still pending and the
            // email matches the authenticated user. The email column is stored
            // lowercased (CHECK constraint), so compare with lower($2).
            // useStructuredResult=true is required here: TypeORM returns
            // [rows, rowCount] for UPDATE queries by default, so without it
            // claimed[0] would be the rows array, not a row object.
            const claimResult = await runner.query(
                `UPDATE organisation_invitations
                    SET status = 'accepted',
                        decided_at = now()
                  WHERE id = $1
                    AND status = 'pending'
                    AND email = lower($2)
              RETURNING organisation_id, role_id`,
                [id, user.email],
                true,
            );
            const claimed = (claimResult.records ?? []) as { organisation_id: string; role_id: string }[];

            if (!claimed || claimed.length === 0) {
                throw new NotFoundException(
                    'Invitation not found or for a different email',
                );
            }

            const organisationId = claimed[0].organisation_id;
            const roleId = Number(claimed[0].role_id);

            // Insert team_members membership (ON CONFLICT: idempotent).
            await runner.query(
                `INSERT INTO team_members (organisation_id, id, role_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (organisation_id, id) DO NOTHING`,
                [organisationId, user.id, roleId],
            );

            // Copy invitation permissions -> user_permission (idempotent).
            await runner.query(
                `INSERT INTO user_permission (organisation_id, user_id, permission_id)
                 SELECT $1, $2, ip.permission_id
                   FROM organisation_invitation_permissions ip
                  WHERE ip.invitation_id = $3
                 ON CONFLICT DO NOTHING`,
                [organisationId, user.id, id],
            );

            const slugRows = (await runner.query(
                `SELECT slug FROM organisations WHERE id = $1`,
                [organisationId],
            )) as { slug: string }[];

            await runner.commitTransaction();

            return {
                organisation_id: organisationId,
                organisation_slug: slugRows[0]?.slug ?? '',
            };
        } catch (e) {
            await runner.rollbackTransaction();
            if (e instanceof NotFoundException) throw e;
            const msg = (e as Error).message ?? String(e);
            throw new InternalServerErrorException(
                `Failed to accept invitation: ${msg}`,
            );
        } finally {
            await runner.release();
        }
    }

    async decline(
        id: string,
        user: { email: string },
    ): Promise<{ ok: true }> {
        const result = (await this.db.query(
            `UPDATE organisation_invitations
                SET status = 'declined',
                    decided_at = now()
              WHERE id = $1
                AND status = 'pending'
                AND email = lower($2)
          RETURNING id`,
            [id, user.email],
        )) as { id: string }[];

        if (!result || result.length === 0) {
            throw new NotFoundException(
                'Invitation not found or for a different email',
            );
        }

        return { ok: true };
    }
}
