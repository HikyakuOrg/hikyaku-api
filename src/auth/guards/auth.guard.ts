import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { TokenVerifier } from 'src/auth/token-verifier.service';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(private readonly tokenVerifier: TokenVerifier) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        request.user = await this.tokenVerifier.verify(
            request.headers['authorization'],
        );
        return true;
    }
}
