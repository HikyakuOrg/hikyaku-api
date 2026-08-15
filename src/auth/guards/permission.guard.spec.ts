import { Test, TestingModule } from '@nestjs/testing';
import {
    BadRequestException,
    ExecutionContext,
    ForbiddenException,
    HttpException,
    HttpStatus,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { ALLOW_EXPIRED_TRIAL_KEY } from 'src/auth/decorators/allow-expired-trial.decorator';
import { PERMISSION_KEY } from 'src/auth/decorators/required-permission.decorator';
import { SKIP_ORG_CONTEXT_KEY } from 'src/auth/decorators/skip-org-context.decorator';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

type SupabaseMock = {
    auth: { getUser: jest.Mock };
    from: jest.Mock;
};

const DAY = 24 * 60 * 60 * 1000;
const future = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const past = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** An org row as the guard selects it: `id` plus the trial deadline. */
type OrgRow = { id: string; trial_ends_at: string | null } | null;

/**
 * The guard reads three tables in sequence, so the mock is keyed by table name
 * rather than by call order — otherwise inserting a query anywhere in the guard
 * silently reassigns every later stub to the wrong table.
 */
function makeSupabase(tables: {
    organisations?: OrgRow;
    team_members?: unknown;
    user_permission?: unknown;
}): SupabaseMock {
    return {
        auth: { getUser: jest.fn() },
        from: jest.fn((table: string) => ({
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest
                .fn()
                .mockResolvedValue({ data: tables[table] ?? null }),
        })),
    };
}

/** A request context; `slug` omitted means the tenant header is absent. */
function makeContext(
    authHeader: string | undefined,
    slug?: string,
): ExecutionContext {
    const headers: Record<string, unknown> = { authorization: authHeader };
    if (slug) headers['x-organisation-slug'] = slug;
    const req: Record<string, unknown> = { headers };
    return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => ({}),
    } as unknown as ExecutionContext;
}

describe('PermissionGuard', () => {
    let guard: PermissionGuard;
    let supabase: SupabaseMock;
    let reflector: { get: jest.Mock };
    let metadata: Record<string, unknown>;

    /** Rebuild the guard against a specific set of table rows. */
    async function build(tables: Parameters<typeof makeSupabase>[0] = {}) {
        supabase = makeSupabase(tables);
        // Keyed rather than ordered, for the same reason as the table mock: the
        // guard reads three metadata keys and the order is an implementation detail.
        reflector = { get: jest.fn((key: string) => metadata[key]) };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PermissionGuard,
                { provide: SUPABASE_CLIENT, useValue: supabase },
                { provide: Reflector, useValue: reflector },
            ],
        }).compile();
        guard = module.get<PermissionGuard>(PermissionGuard);
    }

    beforeEach(async () => {
        metadata = {};
        await build();
    });

    /** Marks the token valid so a test can get past authentication. */
    function authenticated(userId = 'u1') {
        supabase.auth.getUser.mockResolvedValue({
            data: { user: { id: userId } },
            error: null,
        });
    }

    describe('authentication', () => {
        it('throws UnauthorizedException when Authorization header is absent', async () => {
            await expect(guard.canActivate(makeContext(undefined))).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('throws UnauthorizedException for non-bearer format', async () => {
            await expect(
                guard.canActivate(makeContext('ApiKey some-key')),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws UnauthorizedException when the header has only one part', async () => {
            await expect(guard.canActivate(makeContext('Bearer'))).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('throws UnauthorizedException when supabase returns an error', async () => {
            supabase.auth.getUser.mockResolvedValueOnce({
                data: null,
                error: new Error('token invalid'),
            });
            await expect(
                guard.canActivate(makeContext('Bearer bad-token')),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('throws UnauthorizedException when supabase returns no user', async () => {
            supabase.auth.getUser.mockResolvedValueOnce({
                data: { user: null },
                error: null,
            });
            await expect(
                guard.canActivate(makeContext('Bearer bad-token')),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    describe('tenant context', () => {
        it('returns true for a @SkipOrgContext route with no tenant header', async () => {
            metadata[SKIP_ORG_CONTEXT_KEY] = true;
            authenticated();
            await expect(guard.canActivate(makeContext('Bearer valid'))).resolves.toBe(
                true,
            );
        });

        it('throws BadRequestException when the tenant header is missing', async () => {
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid')),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws ForbiddenException for an unknown organisation', async () => {
            await build({ organisations: null });
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid', 'ghost-org')),
            ).rejects.toThrow(ForbiddenException);
        });

        it('throws ForbiddenException when the caller is not a member', async () => {
            await build({
                organisations: { id: 'org-1', trial_ends_at: null },
                team_members: null,
            });
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid', 'acme')),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('permissions', () => {
        it('returns true when no permission is required on the handler', async () => {
            await build({
                organisations: { id: 'org-1', trial_ends_at: null },
                team_members: { id: 'u1' },
            });
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid', 'acme')),
            ).resolves.toBe(true);
        });

        it('returns true when the user has the required permission', async () => {
            metadata[PERMISSION_KEY] = 'team_members.add';
            await build({
                organisations: { id: 'org-1', trial_ends_at: null },
                team_members: { id: 'u1' },
                user_permission: { id: 'perm-1' },
            });
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid', 'acme')),
            ).resolves.toBe(true);
        });

        it('throws ForbiddenException when the user lacks the required permission', async () => {
            metadata[PERMISSION_KEY] = 'team_members.delete';
            await build({
                organisations: { id: 'org-1', trial_ends_at: null },
                team_members: { id: 'u1' },
                user_permission: null,
            });
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid', 'acme')),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('trial enforcement', () => {
        /** Resolve the guard's outcome as a status code, or 200 when it allowed. */
        async function statusFor(trial_ends_at: string | null) {
            await build({
                organisations: { id: 'org-1', trial_ends_at },
                team_members: { id: 'u1' },
            });
            authenticated();
            try {
                await guard.canActivate(makeContext('Bearer valid', 'acme'));
                return HttpStatus.OK;
            } catch (e) {
                return (e as HttpException).getStatus();
            }
        }

        it('allows an organisation whose trial is still running', async () => {
            expect(await statusFor(future(3))).toBe(HttpStatus.OK);
        });

        // The regression that matters most: personal orgs and every pre-existing
        // org carry a null deadline and must stay unrestricted.
        it('allows an organisation with no trial at all', async () => {
            expect(await statusFor(null)).toBe(HttpStatus.OK);
        });

        it('answers 402 once the trial has elapsed', async () => {
            expect(await statusFor(past(1))).toBe(HttpStatus.PAYMENT_REQUIRED);
        });

        it('lets @AllowExpiredTrial routes through after expiry', async () => {
            metadata[ALLOW_EXPIRED_TRIAL_KEY] = true;
            expect(await statusFor(past(1))).toBe(HttpStatus.OK);
        });

        // Non-membership must win, so an outsider cannot probe an org's billing
        // state by watching for 402 instead of 403.
        it('still answers 403, not 402, for a non-member of an expired org', async () => {
            await build({
                organisations: { id: 'org-1', trial_ends_at: past(1) },
                team_members: null,
            });
            authenticated();
            await expect(
                guard.canActivate(makeContext('Bearer valid', 'acme')),
            ).rejects.toThrow(ForbiddenException);
        });
    });
});
