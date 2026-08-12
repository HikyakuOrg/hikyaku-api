import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

/**
 * This API resolves the active organisation from two genuinely different header
 * names, split by whether the caller is authenticated. They are not casing
 * variants of one header — the strings differ, and HTTP's case-insensitivity
 * does not bridge them:
 *
 *   `X-Organisation-Slug`  authenticated dashboard routes. PermissionGuard reads
 *                          it (`request.headers['x-organisation-slug']`) and
 *                          rejects the request without it, so it is the tenant
 *                          boundary itself rather than a hint.
 *
 *   `x-org-slug`           the unauthenticated public routes — the booking page
 *                          and the routing preview it calls. Read directly off
 *                          the handler with `@Headers('x-org-slug')`; there is
 *                          no guard in front of them to read anything else.
 *
 * The split is deliberate and load-bearing: the public site is served from
 * `<slug>.hikyaku.org` and its middleware forwards `x-org-slug`, while the
 * dashboard resolves the slug from its own session and sends the long form. Use
 * the decorator matching the route's auth posture — never both.
 */

/** Tenant header for authenticated routes behind `PermissionGuard`. */
export const ApiOrganisationSlugHeader = () =>
    applyDecorators(
        ApiHeader({
            name: 'X-Organisation-Slug',
            required: true,
            description:
                'Slug of the organisation the request acts on. The caller must be ' +
                'a member of it. Required — the request is rejected without it.',
            schema: { type: 'string', example: 'acme-logistics' },
        }),
    );

/**
 * Tenant header for the unauthenticated public routes.
 *
 * `required` is false only on `GET /api/v1/services/catalog`, which answers with
 * an empty catalog rather than an error when the slug is absent.
 */
export const ApiOrgSlugHeader = (options: { required?: boolean } = {}) =>
    applyDecorators(
        ApiHeader({
            name: 'x-org-slug',
            required: options.required ?? true,
            description:
                'Slug of the organisation being booked with, forwarded by the ' +
                'public site’s middleware. Distinct from the authenticated ' +
                'routes’ `X-Organisation-Slug` — see the schema description.' +
                (options.required === false
                    ? ' Optional here: an absent slug yields an empty catalog rather than an error.'
                    : ''),
            schema: { type: 'string', example: 'acme-logistics' },
        }),
    );
