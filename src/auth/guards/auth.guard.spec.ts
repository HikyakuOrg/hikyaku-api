import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

function makeContext(
    headers: Record<string, string | undefined>,
): ExecutionContext {
    const req: Record<string, unknown> = { headers };
    return {
        switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
    let guard: AuthGuard;
    let supabase: { auth: { getUser: jest.Mock } };

    beforeEach(async () => {
        supabase = { auth: { getUser: jest.fn() } };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthGuard,
                { provide: SUPABASE_CLIENT, useValue: supabase },
            ],
        }).compile();
        guard = module.get<AuthGuard>(AuthGuard);
    });

    it('throws UnauthorizedException when Authorization header is absent', async () => {
        await expect(guard.canActivate(makeContext({}))).rejects.toThrow(
            UnauthorizedException,
        );
    });

    it('throws UnauthorizedException when header has no token after space', async () => {
        await expect(
            guard.canActivate(makeContext({ authorization: 'Bearer' })),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when supabase returns an error', async () => {
        supabase.auth.getUser.mockResolvedValueOnce({
            data: null,
            error: new Error('token expired'),
        });
        await expect(
            guard.canActivate(makeContext({ authorization: 'Bearer bad-token' })),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('sets req.user and returns true for a valid token', async () => {
        const user = { id: 'user-1', email: 'u@example.com' };
        supabase.auth.getUser.mockResolvedValueOnce({
            data: { user },
            error: null,
        });
        const req: { headers: Record<string, string>; user?: unknown } = {
            headers: { authorization: 'Bearer valid-token' },
        };
        const ctx = {
            switchToHttp: () => ({ getRequest: () => req }),
        } as unknown as ExecutionContext;

        const result = await guard.canActivate(ctx);

        expect(result).toBe(true);
        expect(req.user).toBe(user);
    });
});
