import * as dotenv from 'dotenv';
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

// This runs before Nest's ConfigModule, so load the same env files ourselves
// (see src/database/data-source.ts) to see SENTRY_DSN if it's only set there.
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

// Error tracking is opt-in: only initialize Sentry when a DSN is configured.
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        integrations: [nodeProfilingIntegration()],
        tracesSampleRate: 1.0,
        profilesSampleRate: 1.0,
    });
}
