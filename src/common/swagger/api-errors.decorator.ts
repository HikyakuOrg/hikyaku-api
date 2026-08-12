import { applyDecorators } from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiConflictResponse,
    ApiForbiddenResponse,
    ApiNotFoundResponse,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorDto } from './api-error.dto';

/**
 * The failures every route behind `PermissionGuard` shares, applied once at
 * controller level. The guard raises all three before a handler ever runs:
 * 401 for the token, 400 for a missing tenant header, 403 for an unknown org,
 * a non-membership, or a missing permission.
 *
 * Routes marked `@SkipOrgContext()` never raise the 400 — use
 * {@link ApiAuthErrors} for those instead.
 */
export const ApiGuardErrors = () =>
    applyDecorators(
        ApiUnauthorizedResponse({
            description: 'Missing, malformed or expired bearer token.',
            type: ApiErrorDto,
        }),
        ApiBadRequestResponse({
            description:
                'Missing `X-Organisation-Slug` header, or the request body failed ' +
                'validation.',
            type: ApiErrorDto,
        }),
        ApiForbiddenResponse({
            description:
                'Unknown organisation, the caller is not a member of it, or the ' +
                'required permission is missing.',
            type: ApiErrorDto,
        }),
    );

/**
 * Authentication-only failures, for `@SkipOrgContext()` routes that run before a
 * tenant has been chosen — the guard validates the token and stops there.
 */
export const ApiAuthErrors = () =>
    applyDecorators(
        ApiUnauthorizedResponse({
            description: 'Missing, malformed or expired bearer token.',
            type: ApiErrorDto,
        }),
    );

/** A 400 with the shared error schema and a route-specific description. */
export const ApiBadRequest = (description: string) =>
    ApiBadRequestResponse({ description, type: ApiErrorDto });

/** A 404 with the shared error schema and a route-specific description. */
export const ApiNotFound = (description: string) =>
    ApiNotFoundResponse({ description, type: ApiErrorDto });

/** A 409 with the shared error schema and a route-specific description. */
export const ApiConflict = (description: string) =>
    ApiConflictResponse({ description, type: ApiErrorDto });
