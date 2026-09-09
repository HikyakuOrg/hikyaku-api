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
import { NEEDS_FULL_USER_KEY } from 'src/auth/decorators/needs-full-user.decorator';
import { PERMISSION_KEY } from 'src/auth/decorators/required-permission.decorator';
import { SKIP_ORG_CONTEXT_KEY } from 'src/auth/decorators/skip-org-context.decorator';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { TokenVerifier } from 'src/auth/token-verifier.service';

const DAY = 24 * 60 * 60 * 1000;
const future = (days: number) =>
    new Date(Date.now() + days * DAY).toISOString();
const past = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/**
 * The single row canActivate() now selects: the org plus its two embeds. Both
 * embeds are LEFT joins in the real query (see OrgGuardRow in
 * permission.guard.ts), so "not a member" / "missing permission" come back as
 * an empty array on an otherwise-present row, not a missing row at all —
 * `null` models the one case that really has no row: an unknown slug.
 */
type OrgRow = {
    id: string;
    trial_ends_at: string | null;
    subscription_status?: string | null;
    team_members: { id: string }[];
    user_permission?: { app_permission: { permission: string } }[];
} | null;

/** Stubs the guard's one query: .from('organisations').select(...).eq(...)...maybeSingle(). */
function makeSupabase(org: OrgRow) {
    return {
        from: jest.fn(() => ({
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: org }),
        })),
    };
}

/** A request context; `slug` omitted means the tenant header is absent. */
function makeContext(slug?: string): ExecutionContext {
    const headers: Record<string, unknown> = { authorization: 'Bearer valid' };
    if (slug) headers['x-organisation-slug'] = slug;
    const req: Record<string, unknown> = { headers };
    return {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => ({}),
    } as unknown as ExecutionContext;
}

describe('PermissionGuard', () => {
    let guard: PermissionGuard;
    let supabase: ReturnType<typeof makeSupabase>;
    let tokenVerifier: { verify: jest.Mock; verifyFull: jest.Mock };
    let reflector: { get: jest.Mock };
    let metadata: Record<string, unknown>;

    /** Rebuild the guard against a specific organisations row. */
    async function build(org: OrgRow = null) {
        supabase = makeSupabase(org);
        // Keyed rather than ordered: the guard reads several metadata keys and
        // the order is an implementation detail.
        reflector = { get: jest.fn((key: string) => metadata[key]) };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PermissionGuard,
                { provide: SUPABASE_CLIENT, useValue: supabase },
                { provide: TokenVerifier, useValue: tokenVerifier },
                { provide: Reflector, useValue: reflector },
            ],
        }).compile();
        guard = module.get<PermissionGuard>(PermissionGuard);
    }

    beforeEach(async () => {
        metadata = {};
        // Header parsing, signature verification, memoisation and issuer
        // checks are TokenVerifier's own concern — see
        // token-verifier.service.spec.ts. This guard only needs to know:
        // verify()/verifyFull() resolve to a user, or reject, and it reacts
        // correctly either way.
        tokenVerifier = {
            verify: jest
                .fn()
                .mockResolvedValue({ id: 'u1', email: 'u1@example.com' }),
            verifyFull: jest.fn().mockResolvedValue({
                id: 'u1',
                email: 'u1@example.com',
                email_confirmed_at: '2024-01-01T00:00:00Z',
            }),
        };
        await build();
    });

    describe('authentication', () => {
        it('propagates a TokenVerifier rejection', async () => {
            tokenVerifier.verify.mockRejectedValueOnce(
                new UnauthorizedException('Invalid or expired token'),
            );
            await expect(guard.canActivate(makeContext())).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('sets request.user from the verified token', async () => {
            metadata[SKIP_ORG_CONTEXT_KEY] = true;
            const req: Record<string, unknown> = {
                headers: { authorization: 'Bearer valid' },
            };
            const ctx = {
                switchToHttp: () => ({ getRequest: () => req }),
                getHandler: () => ({}),
            } as unknown as ExecutionContext;

            await guard.canActivate(ctx);

            expect(req.user).toEqual({ id: 'u1', email: 'u1@example.com' });
        });

        it('calls verifyFull() instead of verify() on a @NeedsFullUser route', async () => {
            metadata[SKIP_ORG_CONTEXT_KEY] = true;
            metadata[NEEDS_FULL_USER_KEY] = true;

            await guard.canActivate(makeContext());

            expect(tokenVerifier.verifyFull).toHaveBeenCalledWith(
                'Bearer valid',
            );
            expect(tokenVerifier.verify).not.toHaveBeenCalled();
        });
    });

    describe('tenant context', () => {
        it('returns true for a @SkipOrgContext route with no tenant header', async () => {
            metadata[SKIP_ORG_CONTEXT_KEY] = true;
            await expect(guard.canActivate(makeContext())).resolves.toBe(true);
        });

        it('throws BadRequestException when the tenant header is missing', async () => {
            await expect(guard.canActivate(makeContext())).rejects.toThrow(
                BadRequestException,
            );
        });

        it('throws ForbiddenException for an unknown organisation', async () => {
            await build(null);
            await expect(
                guard.canActivate(makeContext('ghost-org')),
            ).rejects.toThrow(ForbiddenException);
        });

        it('throws ForbiddenException when the caller is not a member', async () => {
            await build({ id: 'org-1', trial_ends_at: null, team_members: [] });
            await expect(
                guard.canActivate(makeContext('acme')),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('permissions', () => {
        it('returns true when no permission is required on the handler', async () => {
            await build({
                id: 'org-1',
                trial_ends_at: null,
                team_members: [{ id: 'u1' }],
            });
            await expect(guard.canActivate(makeContext('acme'))).resolves.toBe(
                true,
            );
        });

        it('returns true when the user has the required permission', async () => {
            metadata[PERMISSION_KEY] = 'team_members.add';
            await build({
                id: 'org-1',
                trial_ends_at: null,
                team_members: [{ id: 'u1' }],
                user_permission: [
                    { app_permission: { permission: 'team_members.add' } },
                ],
            });
            await expect(guard.canActivate(makeContext('acme'))).resolves.toBe(
                true,
            );
        });

        it('throws ForbiddenException when the user lacks the required permission', async () => {
            metadata[PERMISSION_KEY] = 'team_members.delete';
            await build({
                id: 'org-1',
                trial_ends_at: null,
                team_members: [{ id: 'u1' }],
                user_permission: [],
            });
            await expect(
                guard.canActivate(makeContext('acme')),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('trial enforcement', () => {
        /** Resolve the guard's outcome as a status code, or 200 when it allowed. */
        async function statusFor(
            trial_ends_at: string | null,
            subscription_status: string | null = 'trialing',
        ) {
            await build({
                id: 'org-1',
                trial_ends_at,
                subscription_status,
                team_members: [{ id: 'u1' }],
            });
            try {
                await guard.canActivate(makeContext('acme'));
                return HttpStatus.OK;
            } catch (e) {
                return (e as HttpException).getStatus();
            }
        }

        it('allows an organisation whose trial is still running', async () => {
            expect(await statusFor(future(3), 'trialing')).toBe(HttpStatus.OK);
        });

        // The regression that matters most: personal orgs, and every company org
        // not yet provisioned, carry a null status and must stay unrestricted.
        it('allows an organisation with no subscription at all', async () => {
            expect(await statusFor(null, null)).toBe(HttpStatus.OK);
        });

        // Every company org that predated Stripe billing was backfilled to this
        // sentinel and must never be locked out by it.
        it('allows a grandfathered organisation regardless of any stray deadline', async () => {
            expect(await statusFor(past(30), 'grandfathered')).toBe(
                HttpStatus.OK,
            );
        });

        it('answers 402 once a real Stripe subscription is canceled', async () => {
            expect(await statusFor(past(1), 'canceled')).toBe(
                HttpStatus.PAYMENT_REQUIRED,
            );
        });

        // Belt-and-suspenders: status can lag a webhook that has not landed yet,
        // so the cached deadline is still honoured while nominally trialing.
        it('answers 402 once trialing but the cached deadline has elapsed', async () => {
            expect(await statusFor(past(1), 'trialing')).toBe(
                HttpStatus.PAYMENT_REQUIRED,
            );
        });

        it('lets @AllowExpiredTrial routes through after expiry', async () => {
            metadata[ALLOW_EXPIRED_TRIAL_KEY] = true;
            expect(await statusFor(past(1), 'canceled')).toBe(HttpStatus.OK);
        });

        // Non-membership must win, so an outsider cannot probe an org's billing
        // state by watching for 402 instead of 403.
        it('still answers 403, not 402, for a non-member of an expired org', async () => {
            await build({
                id: 'org-1',
                trial_ends_at: past(1),
                team_members: [],
            });
            await expect(
                guard.canActivate(makeContext('acme')),
            ).rejects.toThrow(ForbiddenException);
        });
    });
});
