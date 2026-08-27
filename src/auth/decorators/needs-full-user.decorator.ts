import { SetMetadata } from '@nestjs/common';

export const NEEDS_FULL_USER_KEY = 'needs_full_user';

/**
 * Opts a handler into an extra Supabase round-trip to populate
 * `request.user.email_confirmed_at`, which is not a JWT claim and so is
 * otherwise left undefined (see AuthedUser). Route-scoped rather than the
 * default so the cost is paid only where it's actually needed — today, just
 * POST /api/v1/invitations/:id/accept, which gates on it.
 */
export const NeedsFullUser = () => SetMetadata(NEEDS_FULL_USER_KEY, true);
