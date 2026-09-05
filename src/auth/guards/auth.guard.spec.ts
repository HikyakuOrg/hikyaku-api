import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { TokenVerifier } from 'src/auth/token-verifier.service';

// Header parsing, signature verification, memoisation and issuer checks are
// TokenVerifier's own concern — see token-verifier.service.spec.ts. This guard
// is a thin wrapper, so its spec only needs to confirm the wrapping: the
// header goes in, the verified user comes back out on request.user, and a
// rejection from TokenVerifier propagates as-is.
describe('AuthGuard', () => {
    let guard: AuthGuard;
    let tokenVerifier: { verify: jest.Mock };

    beforeEach(async () => {
        tokenVerifier = { verify: jest.fn() };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthGuard,
                { provide: TokenVerifier, useValue: tokenVerifier },
            ],
        }).compile();
        guard = module.get<AuthGuard>(AuthGuard);
    });

    function makeContext(authHeader: string | undefined): {
        ctx: ExecutionContext;
        req: { headers: Record<string, string | undefined>; user?: unknown };
    } {
        const req: {
            headers: Record<string, string | undefined>;
            user?: unknown;
        } = {
            headers: { authorization: authHeader },
        };
        const ctx = {
            switchToHttp: () => ({ getRequest: () => req }),
        } as unknown as ExecutionContext;
        return { ctx, req };
    }

    it('propagates a TokenVerifier rejection', async () => {
        tokenVerifier.verify.mockRejectedValueOnce(
            new UnauthorizedException('Invalid token'),
        );
        const { ctx } = makeContext('Bearer bad-token');

        await expect(guard.canActivate(ctx)).rejects.toThrow(
            UnauthorizedException,
        );
    });

    it('sets req.user and returns true for a valid token', async () => {
        const user = { id: 'user-1', email: 'u@example.com' };
        tokenVerifier.verify.mockResolvedValueOnce(user);
        const { ctx, req } = makeContext('Bearer valid-token');

        const result = await guard.canActivate(ctx);

        expect(result).toBe(true);
        expect(req.user).toBe(user);
        expect(tokenVerifier.verify).toHaveBeenCalledWith('Bearer valid-token');
    });
});
