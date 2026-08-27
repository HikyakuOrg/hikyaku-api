import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { AuthedUser } from './authed-user';

/**
 * How long a verified token's claims stay memoised. Deliberately short: this
 * exists only to collapse a burst of requests from one caller on one token —
 * e.g. the geocode autocomplete firing on every keystroke — not to act as a
 * session cache. The shorter it is, the less revocation lag it adds on top of
 * the token's own expiry, which verify() never lets it outlive regardless.
 */
export const TOKEN_MEMO_TTL_MS = 5_000;

/**
 * Hard cap on memo entries. The key is derived from whatever bearer token a
 * caller sends, valid or not (see verify()), so an unbounded map would be a
 * memory-exhaustion vector for anyone who can reach an authenticated route.
 * `Map` preserves insertion order, so the oldest entry is evicted on overflow;
 * a hit deletes-then-reinserts its entry, which makes eviction LRU in practice.
 */
export const MEMO_MAX_ENTRIES = 5_000;

interface MemoEntry {
    user: AuthedUser;
    expiresAt: number;
}

/**
 * Verifies a bearer token once per short memo window instead of once per
 * request, and is the single place both AuthGuard and PermissionGuard go for
 * "who is this caller" — see AuthedUser for the shape they get back.
 *
 * Verification itself is supabase-js's getClaims(), not getUser(): getClaims()
 * verifies the JWT locally via WebCrypto against a JWKS the SDK caches
 * process-wide for 10 minutes, so — unlike getUser() — it costs no network
 * round-trip per call once that cache is warm. On a project still using a
 * symmetric (HS256) signing secret, getClaims() itself falls back to a
 * getUser() network call, so this degrades to the old behaviour rather than
 * breaking; the project this was written against uses ES256, so the fast path
 * is the one that runs.
 */
@Injectable()
export class TokenVerifier {
    // Insertion-ordered by construction (Map) — the LRU eviction above and the
    // "touch on hit" logic in verifyToken() both depend on that ordering.
    private readonly memo = new Map<string, MemoEntry>();

    private readonly expectedIssuer = `${process.env.SUPABASE_URL}/auth/v1`;

    constructor(
        @Inject(SUPABASE_CLIENT)
        private readonly supabase: SupabaseClient,
    ) { }

    /** Parses `Bearer <token>`, verifies it (memoised), and returns the caller. */
    async verify(authHeader: string | undefined): Promise<AuthedUser> {
        return this.verifyToken(this.extractToken(authHeader));
    }

    /**
     * Same as verify(), but additionally populates email_confirmed_at — the one
     * field JWT claims don't carry (see AuthedUser). For @NeedsFullUser()
     * routes only: this always costs a real Supabase round-trip, run in
     * parallel with the (usually local) claims verification since the two are
     * independent.
     */
    async verifyFull(authHeader: string | undefined): Promise<AuthedUser> {
        const token = this.extractToken(authHeader);
        const [user, email_confirmed_at] = await Promise.all([
            this.verifyToken(token),
            this.fetchEmailConfirmedAt(token),
        ]);
        return { ...user, email_confirmed_at };
    }

    private extractToken(authHeader: string | undefined): string {
        if (!authHeader) {
            throw new UnauthorizedException('Missing Authorization header');
        }
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
            throw new UnauthorizedException('Invalid Authorization header format');
        }
        return parts[1];
    }

    private async verifyToken(token: string): Promise<AuthedUser> {
        const now = Date.now();

        const key = this.memoKey(token);
        const cached = this.memo.get(key);
        if (cached) {
            this.memo.delete(key);
            if (cached.expiresAt > now) {
                this.memo.set(key, cached); // re-insert: touch as most-recently-used
                return cached.user;
            }
            // else: stale — fall through and re-verify, memo already cleared above
        }

        // Verification failures are NOT memoised: they're already cheap (local
        // for a bad signature, immediate for a malformed JWT), and a negative
        // cache keyed on attacker-supplied input is the same exhaustion vector
        // as a positive one, with none of the benefit.
        const { user, expiresAtMs } = await this.verifyClaims(token);

        if (this.memo.size >= MEMO_MAX_ENTRIES) {
            const oldestKey = this.memo.keys().next().value;
            if (oldestKey !== undefined) this.memo.delete(oldestKey);
        }
        this.memo.set(key, {
            user,
            // Never serve a memo entry past the token's own expiry.
            expiresAt: Math.min(now + TOKEN_MEMO_TTL_MS, expiresAtMs),
        });

        return user;
    }

    /**
     * Hashed rather than keyed on the raw JWT: bounds the memo key size and
     * keeps a live credential out of a heap structure that outlives the
     * request, for roughly 1% of the cost verification itself saves.
     */
    private memoKey(token: string): string {
        return createHash('sha256').update(token).digest('base64url');
    }

    private async verifyClaims(
        token: string,
    ): Promise<{ user: AuthedUser; expiresAtMs: number }> {
        const { data, error } = await this.supabase.auth.getClaims(token);
        if (error || !data) {
            throw new UnauthorizedException('Invalid or expired token');
        }
        const { claims } = data;

        // getClaims() verifies signature and exp, but not issuer. Staging and
        // production run side by side on the same host against different
        // Supabase projects (see infra/README.md) — without this check, a
        // staging token would verify successfully against production too.
        if (claims.iss !== this.expectedIssuer) {
            throw new UnauthorizedException('Invalid token issuer');
        }

        if (!claims.email) {
            throw new UnauthorizedException('Token is missing required claims');
        }

        return {
            user: { id: claims.sub, email: claims.email },
            expiresAtMs: claims.exp * 1000,
        };
    }

    /** Always a network call, never memoised — the point of calling it is to
     *  be fresher than the token's own (unrelated) claims. */
    private async fetchEmailConfirmedAt(token: string): Promise<string | null> {
        const { data, error } = await this.supabase.auth.getUser(token);
        if (error || !data.user) {
            throw new UnauthorizedException('Invalid or expired token');
        }
        return data.user.email_confirmed_at ?? null;
    }
}
