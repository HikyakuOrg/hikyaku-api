import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import {
    MEMO_MAX_ENTRIES,
    TOKEN_MEMO_TTL_MS,
    TokenVerifier,
} from './token-verifier.service';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

const SUPABASE_URL = 'https://project.supabase.test';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

/** A getClaims() success response, shaped like the real SDK's. */
function claimsResult(overrides: Record<string, unknown> = {}) {
    return {
        data: {
            claims: {
                sub: 'user-1',
                email: 'user@example.com',
                iss: ISSUER,
                aud: 'authenticated',
                role: 'authenticated',
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
                ...overrides,
            },
            header: { alg: 'ES256', typ: 'JWT' },
            signature: new Uint8Array(),
        },
        error: null,
    };
}

describe('TokenVerifier', () => {
    let verifier: TokenVerifier;
    let supabase: { auth: { getClaims: jest.Mock; getUser: jest.Mock } };
    const originalSupabaseUrl = process.env.SUPABASE_URL;

    async function build() {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TokenVerifier,
                { provide: SUPABASE_CLIENT, useValue: supabase },
            ],
        }).compile();
        verifier = module.get<TokenVerifier>(TokenVerifier);
    }

    beforeEach(async () => {
        process.env.SUPABASE_URL = SUPABASE_URL;
        supabase = {
            auth: {
                getClaims: jest.fn().mockResolvedValue(claimsResult()),
                getUser: jest.fn(),
            },
        };
        await build();
    });

    afterEach(() => {
        jest.useRealTimers();
        if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
        else process.env.SUPABASE_URL = originalSupabaseUrl;
    });

    describe('header parsing', () => {
        it('rejects a missing Authorization header', async () => {
            await expect(verifier.verify(undefined)).rejects.toThrow(
                UnauthorizedException,
            );
            expect(supabase.auth.getClaims).not.toHaveBeenCalled();
        });

        it('rejects a header with no token after the scheme', async () => {
            await expect(verifier.verify('Bearer')).rejects.toThrow(
                UnauthorizedException,
            );
            expect(supabase.auth.getClaims).not.toHaveBeenCalled();
        });

        it('rejects a non-bearer scheme', async () => {
            await expect(verifier.verify('ApiKey some-key')).rejects.toThrow(
                UnauthorizedException,
            );
            expect(supabase.auth.getClaims).not.toHaveBeenCalled();
        });
    });

    describe('verification', () => {
        it('returns id/email built from the verified claims', async () => {
            const user = await verifier.verify('Bearer good-token');
            expect(user).toEqual({ id: 'user-1', email: 'user@example.com' });
        });

        it('rejects when getClaims() reports an error', async () => {
            supabase.auth.getClaims.mockResolvedValueOnce({
                data: null,
                error: new Error('invalid signature'),
            });
            await expect(verifier.verify('Bearer bad-token')).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it('rejects when the issuer does not match this project', async () => {
            supabase.auth.getClaims.mockResolvedValueOnce(
                claimsResult({
                    iss: 'https://someone-elses-project.supabase.co/auth/v1',
                }),
            );
            await expect(
                verifier.verify('Bearer staging-token'),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('rejects claims with no email', async () => {
            supabase.auth.getClaims.mockResolvedValueOnce(
                claimsResult({ email: undefined }),
            );
            await expect(
                verifier.verify('Bearer no-email-token'),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    describe('memoisation', () => {
        it('serves a repeat call for the same token from the memo', async () => {
            await verifier.verify('Bearer same-token');
            await verifier.verify('Bearer same-token');
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(1);
        });

        it('verifies each distinct token independently', async () => {
            await verifier.verify('Bearer token-a');
            await verifier.verify('Bearer token-b');
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(2);
        });

        it('does not memoise a verification failure', async () => {
            supabase.auth.getClaims.mockResolvedValueOnce({
                data: null,
                error: new Error('invalid signature'),
            });
            await expect(verifier.verify('Bearer retry-token')).rejects.toThrow(
                UnauthorizedException,
            );

            // Second attempt, same token: the mock now succeeds. If the failure
            // had been memoised, this would still reject without a second
            // getClaims() call.
            const user = await verifier.verify('Bearer retry-token');

            expect(user).toEqual({ id: 'user-1', email: 'user@example.com' });
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(2);
        });

        it('never serves a memo entry past the token’s own expiry', async () => {
            jest.useFakeTimers();
            const now = Date.parse('2026-01-01T00:00:00Z');
            jest.setSystemTime(now);

            // Expires in 2s — inside the 5s memo TTL, so a naive fixed-TTL memo
            // would still serve this from cache after 3s. It must not.
            supabase.auth.getClaims.mockResolvedValueOnce(
                claimsResult({ exp: Math.floor(now / 1000) + 2 }),
            );
            await verifier.verify('Bearer short-lived-token');
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(1);

            jest.setSystemTime(now + 3_000);
            await verifier.verify('Bearer short-lived-token');

            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(2);
        });

        it('honours the exported TTL for a token whose own expiry is far off', async () => {
            jest.useFakeTimers();
            const now = Date.parse('2026-01-01T00:00:00Z');
            jest.setSystemTime(now);

            await verifier.verify('Bearer long-lived-token'); // exp is +1h by default

            jest.setSystemTime(now + TOKEN_MEMO_TTL_MS - 1);
            await verifier.verify('Bearer long-lived-token');
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(1); // still memoised

            jest.setSystemTime(now + TOKEN_MEMO_TTL_MS + 1);
            await verifier.verify('Bearer long-lived-token');
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(2); // TTL elapsed
        });

        it('evicts the oldest entry once the cap is reached', async () => {
            for (let i = 0; i < MEMO_MAX_ENTRIES; i++) {
                await verifier.verify(`Bearer token-${i}`);
            }
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(
                MEMO_MAX_ENTRIES,
            );

            // One more distinct token pushes the map over the cap, evicting
            // token-0 (the oldest / least-recently-touched entry).
            await verifier.verify(`Bearer token-${MEMO_MAX_ENTRIES}`);

            // token-0 should have been evicted, so re-verifying it costs a
            // fresh getClaims() call instead of a memo hit.
            await verifier.verify('Bearer token-0');

            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(
                MEMO_MAX_ENTRIES + 2,
            );
        }, 30_000);
    });

    describe('verifyFull()', () => {
        beforeEach(() => {
            supabase.auth.getUser.mockResolvedValue({
                data: { user: { email_confirmed_at: '2024-01-01T00:00:00Z' } },
                error: null,
            });
        });

        it('merges email_confirmed_at from a fresh getUser() call', async () => {
            const user = await verifier.verifyFull('Bearer good-token');
            expect(user).toEqual({
                id: 'user-1',
                email: 'user@example.com',
                email_confirmed_at: '2024-01-01T00:00:00Z',
            });
            expect(supabase.auth.getUser).toHaveBeenCalledWith('good-token');
        });

        it('propagates a getUser() failure', async () => {
            supabase.auth.getUser.mockResolvedValueOnce({
                data: { user: null },
                error: new Error('expired'),
            });
            await expect(
                verifier.verifyFull('Bearer bad-token'),
            ).rejects.toThrow(UnauthorizedException);
        });

        it('still calls getUser() fresh even when claims are already memoised', async () => {
            await verifier.verify('Bearer shared-token');
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(1);

            await verifier.verifyFull('Bearer shared-token');

            // Claims came from the memo (no second getClaims() call); the
            // email-confirmation check is never memoised.
            expect(supabase.auth.getClaims).toHaveBeenCalledTimes(1);
            expect(supabase.auth.getUser).toHaveBeenCalledTimes(1);
        });
    });
});
