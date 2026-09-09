import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { TokenVerifier } from 'src/auth/token-verifier.service';
import type { AuthedRequest } from 'src/auth/authed-user';
import { headerValue } from 'src/common/http';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(private readonly tokenVerifier: TokenVerifier) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<AuthedRequest>();
        request.user = await this.tokenVerifier.verify(
            headerValue(request.headers['authorization']),
        );
        return true;
    }
}
