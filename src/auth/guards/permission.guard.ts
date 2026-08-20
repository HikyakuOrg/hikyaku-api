import {
    BadRequestException,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { ALLOW_EXPIRED_TRIAL_KEY } from 'src/auth/decorators/allow-expired-trial.decorator';
import { PERMISSION_KEY } from 'src/auth/decorators/required-permission.decorator';
import { SKIP_ORG_CONTEXT_KEY } from 'src/auth/decorators/skip-org-context.decorator';
import { isTrialExpired } from 'src/common/trial';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

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
        private readonly reflector: Reflector,
    ) { }

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

        const request = context.switchToHttp().getRequest();
        const authHeader: string | undefined = request.headers['authorization'];

        if (!authHeader) {
            throw new UnauthorizedException('Missing Authorization header');
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
            throw new UnauthorizedException('Invalid Authorization header format');
        }

        const token = parts[1];

        const { data, error } = await this.supabase.auth.getUser(token);
        if (error || !data.user) {
            throw new UnauthorizedException('Invalid or expired token');
        }

        request.user = data.user;

        // Endpoints that run before a tenant is chosen (e.g. /organisations/me)
        // only need authentication.
        if (skipOrgContext) {
            return true;
        }

        // Resolve + authorise the active organisation.
        const slug: string | undefined =
            request.headers['x-organisation-slug'];
        if (!slug) {
            throw new BadRequestException('Missing X-Organisation-Slug header');
        }

        // trial_ends_at/subscription_status ride along on the org lookup the
        // guard already makes, so enforcing the trial costs no extra round-trip.
        const { data: org } = await this.supabase
            .from('organisations')
            .select('id, trial_ends_at, subscription_status')
            .eq('slug', slug)
            .maybeSingle();
        if (!org) {
            throw new ForbiddenException('Unknown organisation');
        }

        const { data: membership } = await this.supabase
            .from('team_members')
            .select('id')
            .eq('organisation_id', org.id)
            .eq('id', data.user.id)
            .maybeSingle();
        if (!membership) {
            throw new ForbiddenException(
                'You are not a member of this organisation',
            );
        }

        request.organisationId = org.id as string;

        // After membership, before permissions. After, so a non-member learns
        // nothing about an org's billing state — they get the same 403 either way.
        // Before, because "your trial ended" explains the failure and "missing
        // permission" would not; it also saves the permission query when the
        // answer cannot be yes regardless.
        const allowExpiredTrial =
            this.reflector.get<boolean>(
                ALLOW_EXPIRED_TRIAL_KEY,
                context.getHandler(),
            ) === true;

        if (!allowExpiredTrial) {
            const orgRow = org as {
                trial_ends_at?: string | null;
                subscription_status?: string | null;
            };
            const trialEndsAt = orgRow.trial_ends_at;
            if (
                isTrialExpired(
                    orgRow.subscription_status,
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

        const { data: permRow } = await this.supabase
            .from('user_permission')
            .select('app_permission!inner(permission)')
            .eq('organisation_id', org.id)
            .eq('user_id', data.user.id)
            .eq('app_permission.permission', requiredPermission)
            .maybeSingle();

        if (!permRow) {
            throw new ForbiddenException(
                `Missing required permission: ${requiredPermission}`,
            );
        }

        return true;
    }
}
