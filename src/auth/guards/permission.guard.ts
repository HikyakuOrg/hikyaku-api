import {
    BadRequestException,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { PERMISSION_KEY } from 'src/auth/decorators/required-permission.decorator';
import { SKIP_ORG_CONTEXT_KEY } from 'src/auth/decorators/skip-org-context.decorator';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

// Single tenant-isolation boundary: validates the bearer token, resolves the
// active organisation from the X-Organisation-Slug header, verifies the user is
// a member of it, and scopes the permission check to that organisation.
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

        const { data: org } = await this.supabase
            .from('organisations')
            .select('id')
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
