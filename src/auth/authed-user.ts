/**
 * The authenticated caller, attached to `request.user` by AuthGuard and
 * PermissionGuard. `id` and `email` come straight off the bearer token's
 * verified JWT claims (`sub`/`email`) and are always present.
 *
 * `email_confirmed_at` is NOT a JWT claim, so by default it is left undefined.
 * It is only populated for routes decorated with @NeedsFullUser() — see
 * needs-full-user.decorator.ts — which pay for an extra Supabase round-trip to
 * fetch it. `undefined` and `null` both read as "not confirmed" wherever this
 * field is checked, so an undecorated route fails closed rather than open.
 */
export interface AuthedUser {
    id: string;
    email: string;
    email_confirmed_at?: string | null;
}

/**
 * The minimal request shape AuthGuard/PermissionGuard read and write.
 * `getRequest()` has no default type, and the concrete request object is
 * whatever the underlying HTTP adapter (Fastify) provides — this is the
 * narrow slice of it these guards actually touch.
 */
export interface AuthedRequest {
    headers: Record<string, string | string[] | undefined>;
    user?: AuthedUser;
    organisationId?: string;
}
