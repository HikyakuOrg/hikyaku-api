import { DocumentBuilder } from '@nestjs/swagger';


export function buildOpenApiConfig() {
    return (
        new DocumentBuilder()
            .setTitle('Hikyaku Logistics API')
            .setDescription(
                'Backend for the Hikyaku dashboard and the public booking site.\n\n' +
                    '**Authentication.** Every route except the public booking and ' +
                    'routing endpoints requires a Supabase access token as ' +
                    '`Authorization: Bearer <jwt>`.\n\n' +
                    '**Tenancy.** Authenticated routes resolve the active organisation ' +
                    'from the `X-Organisation-Slug` header. The unauthenticated booking ' +
                    'and routing routes read `x-org-slug` instead — a separate header, ' +
                    'not a casing variant. Each operation declares the one it expects.\n\n' +
                    '**Errors.** Failures use Nest’s default body ' +
                    '(`{ statusCode, message, error }`); `message` is an array of ' +
                    'strings when request validation is what failed. See `ApiErrorDto`.',
            )
            .setVersion('1.0')
            .setContact(
                'Hikyaku Engineering',
                'https://hikyaku.org',
                'engineering@hikyaku.org',
            )
            .setLicense('AGPL-3.0', 'https://www.gnu.org/licenses/agpl-3.0.html')
            // Without these a generated client has no base URL and every consumer
            // hardcodes one.
            .addServer('https://api.hikyaku.org', 'Production')
            .addServer(
                `http://localhost:${process.env.PORT ?? 3002}`,
                'Local development',
            )
            // Every guard (PermissionGuard, AuthGuard) reads the same standard
            // `Authorization: Bearer <jwt>` — a single scheme covers all of them so
            // generated clients wire the token up rather than treating it as a plain
            // header.
            .addBearerAuth(
                { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                'bearer',
            )
            // Declared explicitly so Swagger UI groups them in a deliberate order with
            // descriptions, rather than sorting whatever strings @ApiTags happens to
            // emit. Names are lower-case throughout — a controller with no @ApiTags
            // falls back to its class name, which is where `Users`/`Invitations` used
            // to come from.
            .addTag('services', 'Service catalog, quoting and booking checkout.')
            .addTag('customers', 'Customer records for the active organisation.')
            .addTag('users', 'Team member provisioning and lifecycle.')
            .addTag(
                'invitations',
                'Organisation invitations: create, accept, decline.',
            )
            .addTag('connect', 'Stripe Connect onboarding and account state.')
            .addTag('issuing', 'Fuel cards and their transactions.')
            .addTag('routing', 'Road-network route previews.')
            .addTag('optimisation', 'Vehicle routing runs and their results.')
            .addTag(
                'geocode',
                'Address search, autocomplete and reverse geocoding.',
            )
            .build()
    );
}
