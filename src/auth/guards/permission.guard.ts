import {
    BadRequestException,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { ALLOW_EXPIRED_TRIAL_KEY } from 'src/auth/decorators/allow-expired-trial.decorator';
import { NEEDS_FULL_USER_KEY } from 'src/auth/decorators/needs-full-user.decorator';
import { PERMISSION_KEY } from 'src/auth/decorators/required-permission.decorator';
import { SKIP_ORG_CONTEXT_KEY } from 'src/auth/decorators/skip-org-context.decorator';
import { TokenVerifier } from 'src/auth/token-verifier.service';
import { isTrialExpired } from 'src/common/trial';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

/**
 * Row shape of the single collapsed organisations query in canActivate(). Both
 * embeds are LEFT joins (no `!inner`) on purpose: an inner join on
 * `team_members` would drop the organisation row entirely for a non-member,
 * making "unknown organisation" and "not a member" indistinguishable — a left
 * embed returns the org with an empty array instead, so both branches (and
 * both error messages) still come out of one round trip. `user_permission` is
 * only present in the select when a permission is required (see canActivate).
 */
interface OrgGuardRow {
    id: string;
    trial_ends_at: string | null;
    subscription_status: string | null;
    team_members: { id: string }[];
    user_permission?: { app_permission: { permission: string } }[];
}

// Single tenant-isolation boundary: validates the bearer token, resolves the
// active organisation from the X-Organisation-Slug header, verifies the user is
// a member of it, and scopes the permission check to that organisation.
//
// It is also where the trial is enforced, for the same reason: this is the one
// place every tenant-scoped request already passes through with the org resolved,
// so the check cannot be forgotten on a new endpoint the way a per-controller
// guard could. Routes that must survive expiry opt out with @AllowExpiredTrial().
@Injectable()
export class PermissionGuard implements CanActivate {
    constructor(
        @Inject(SUPABASE_CLIENT)
        private readonly supabase: SupabaseClient,
        private readonly tokenVerifier: TokenVerifier,
        private readonly reflector: Reflector,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const requiredPermission = this.reflector.get<string>(
            PERMISSION_KEY,
            context.getHandler(),
        );
        const skipOrgContext =
            this.reflector.get<boolean>(
                SKIP_ORG_CONTEXT_KEY,
                context.getHandler(),
            ) === true;
        const needsFullUser =
            this.reflector.get<boolean>(
                NEEDS_FULL_USER_KEY,
                context.getHandler(),
            ) === true;

        const request = context.switchToHttp().getRequest();
        const authHeader: string | undefined = request.headers['authorization'];

        request.user = needsFullUser
            ? await this.tokenVerifier.verifyFull(authHeader)
            : await this.tokenVerifier.verify(authHeader);

        // Endpoints that run before a tenant is chosen (e.g. /organisations/me)
        // only need authentication.
        if (skipOrgContext) {
            return true;
        }

        // Resolve + authorise the active organisation.
        const slug: string | undefined = request.headers['x-organisation-slug'];
        if (!slug) {
            throw new BadRequestException('Missing X-Organisation-Slug header');
        }

        const userId: string = request.user.id;

        // One round trip for everything the rest of this guard needs:
        // trial_ends_at/subscription_status ride along on the org lookup,
        // team_members answers membership, and (when a permission is
        // required) user_permission answers that too — see OrgGuardRow for
        // why both embeds are left joins.
        const baseSelect =
            'id, trial_ends_at, subscription_status, team_members(id)';
        const select = requiredPermission
            ? `${baseSelect}, user_permission(app_permission!inner(permission))`
            : baseSelect;

        const query = this.supabase
            .from('organisations')
            .select(select)
            .eq('slug', slug)
            .eq('team_members.id', userId);
        if (requiredPermission) {
            query.eq('user_permission.user_id', userId);
            query.eq(
                'user_permission.app_permission.permission',
                requiredPermission,
            );
        }

        const { data } = await query.maybeSingle();
        if (!data) {
            throw new ForbiddenException('Unknown organisation');
        }
        const org = data as unknown as OrgGuardRow;

        if (org.team_members.length === 0) {
            throw new ForbiddenException(
                'You are not a member of this organisation',
            );
        }

        request.organisationId = org.id;

        // After membership, before permissions. After, so a non-member learns
        // nothing about an org's billing state — they get the same 403 either way.
        // Before, because "your trial ended" explains the failure and "missing
        // permission" would not.
        const allowExpiredTrial =
            this.reflector.get<boolean>(
                ALLOW_EXPIRED_TRIAL_KEY,
                context.getHandler(),
            ) === true;

        if (!allowExpiredTrial) {
            const trialEndsAt = org.trial_ends_at;
            if (
                isTrialExpired(
                    org.subscription_status,
                    trialEndsAt ? new Date(trialEndsAt) : null,
                )
            ) {
                // 402 rather than 403: the request was authorised and the caller
                // has done nothing wrong, so the frontend keys the trial-ended
                // dialog off this status alone and leaves 403 meaning "not
                // permitted". Nest has no PaymentRequiredException.
                throw new HttpException(
                    'Your free trial has ended. Add a payment method to continue.',
                    HttpStatus.PAYMENT_REQUIRED,
                );
            }
        }

        if (!requiredPermission) {
            return true;
        }

        if (!org.user_permission || org.user_permission.length === 0) {
            throw new ForbiddenException(
                `Missing required permission: ${requiredPermission}`,
            );
        }

        return true;
    }
}
