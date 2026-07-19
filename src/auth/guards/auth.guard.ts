
import {
    CanActivate,
    ExecutionContext,
    Inject,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        @Inject(SUPABASE_CLIENT)
        private readonly supabase: SupabaseClient,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers['authorization'];
        if (!authHeader) {
            throw new UnauthorizedException('Missing Authorization header');
        }
        const [, token] = authHeader.split(' ');

        if (!token) {
            throw new UnauthorizedException('Invalid Authorization header');
        }

        try {
            const user = await this.decodeJwt(token);
            request.user = user;
            return true;
        } catch (err) {
            throw new UnauthorizedException('Invalid token');
        }
    }

    private async decodeJwt(token: string) {
        const { data, error } = await this.supabase.auth.getUser(token);
        if (error) {
            throw new UnauthorizedException(error.message);
        }
        return data.user;
    }
}
