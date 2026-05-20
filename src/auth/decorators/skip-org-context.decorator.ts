import { SetMetadata } from '@nestjs/common';

export const SKIP_ORG_CONTEXT_KEY = 'skip_org_context';

/**
 * Marks a handler as needing authentication only — PermissionGuard will NOT
 * require/resolve an active organisation. Use for endpoints that run before a
 * tenant is chosen (e.g. GET /organisations/me).
 */
export const SkipOrgContext = () => SetMetadata(SKIP_ORG_CONTEXT_KEY, true);
