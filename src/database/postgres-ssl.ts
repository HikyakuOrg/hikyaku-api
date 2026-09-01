import { existsSync, readFileSync } from 'fs';
import type { TlsOptions } from 'tls';

/**
 * Resolves TLS options for the Postgres connection from `DB_SSL_CA_PATH`.
 *
 * Supabase (and most managed Postgres) present a certificate signed by a CA
 * that isn't in Node's default trust store, so verifying it means pointing
 * `ca` at that CA cert explicitly rather than just turning SSL on. When
 * DB_SSL_CA_PATH is unset, or points at a file that isn't there (e.g. a local
 * Postgres that was never issued a cert), the connection falls back to
 * plain, unencrypted TCP instead of failing to boot.
 *
 * Shared by both connections this app opens to Postgres: TypeORM's pool
 * (src/database/data-source.ts, consumed by the CLI and TypeOrmModule.forRoot)
 * and the dedicated LISTEN/NOTIFY client (src/dispatch/pg-notify.service.ts).
 */
export function resolvePostgresSsl(): TlsOptions | undefined {
    const caPath = process.env.DB_SSL_CA_PATH;
    if (!caPath || !existsSync(caPath)) return undefined;
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
}
