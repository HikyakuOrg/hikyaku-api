// Worker-thread entry point: downloads the pinned timezone-boundary release,
// verifies it, and imports it into tzdata.timezone via ogr2ogr. Spawned by
// TzdataService and never awaited, so this file's exports/coverage are
// intentionally excluded from the jest run the same way main.ts is (see
// package.json) — it is a process-entrypoint doing real network/fs/child
// process I/O, not app logic to unit test.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { parentPort } from 'node:worker_threads';
import { Client } from 'pg';
import { ogr2ogr } from 'ogr2ogr';
import {
    TZDATA_SCHEMA,
    TZDATA_TABLE,
    TIMEZONE_BOUNDARY_URL,
    TIMEZONE_BOUNDARY_SHA256,
    TIMEZONE_BOUNDARY_INNER_FILE,
    redactSecrets,
    type TzdataWorkerMessage,
} from './tzdata.constants';

// Arbitrary fixed key identifying this job for pg_try_advisory_lock — only
// needs to not collide with other advisory lock users in this app.
const ADVISORY_LOCK_KEY = 727_002_026;

function log(message: string): void {
    parentPort?.postMessage({ type: 'log', message: redactSecrets(message) } satisfies TzdataWorkerMessage);
}

/** Reports a phase transition — TzdataService surfaces this via GET /api/v1/tzdata/status. */
function status(phase: Extract<TzdataWorkerMessage, { type: 'status' }>['phase']): void {
    parentPort?.postMessage({ type: 'status', phase } satisfies TzdataWorkerMessage);
}

/** Quotes a value for a libpq keyword/value string (the part after `PG:`). */
function quotePgValue(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Builds the libpq DSN and separates out the password: child_process embeds
 * the full argv verbatim in "Command failed: ..." errors on a non-zero exit,
 * so a password baked into this string ends up in plaintext in application
 * logs (and anywhere they're shipped, e.g. Sentry) the moment ogr2ogr fails.
 * The password travels to the child via PGPASSWORD (a standard libpq env
 * fallback) instead — see the `env` option below.
 */
function buildPgConnectionString(dbUrl: string): { dsn: string; password: string } {
    const url = new URL(dbUrl);
    const parts: Record<string, string> = {
        host: url.hostname,
        port: url.port || '5432',
        dbname: url.pathname.replace(/^\//, '') || 'postgres',
        user: decodeURIComponent(url.username),
        sslmode: 'require',
    };
    const dsn = Object.entries(parts)
        .map(([key, value]) => `${key}=${quotePgValue(value)}`)
        .join(' ');
    return { dsn, password: decodeURIComponent(url.password) };
}

/** Downloads the release asset to `destPath`, verifying its sha256 as it streams. */
async function downloadAndVerify(destPath: string): Promise<void> {
    log(`Downloading ${TIMEZONE_BOUNDARY_URL}`);
    const response = await fetch(TIMEZONE_BOUNDARY_URL);
    if (!response.ok || !response.body) {
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    }

    const hash = createHash('sha256');
    const source = Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>);
    source.on('data', (chunk: Buffer) => hash.update(chunk));

    await pipeline(source, createWriteStream(destPath));

    const digest = hash.digest('hex');
    if (digest !== TIMEZONE_BOUNDARY_SHA256) {
        throw new Error(
            `sha256 mismatch for ${TIMEZONE_BOUNDARY_URL}: expected ${TIMEZONE_BOUNDARY_SHA256}, got ${digest}`,
        );
    }
    log(`Downloaded and verified (sha256 ${digest}).`);
}

async function run(): Promise<void> {
    // Direct connection, not the pooled DB_URL: this session holds a
    // pg_try_advisory_lock across the truncate+import, and Supavisor's
    // transaction pooler does not reliably preserve advisory locks or
    // session-level SET across statements on what looks like one client
    // session (see src/database/data-source.ts).
    const dbUrl = process.env.DB_MIGRATION_URL ?? process.env.DB_URL;
    if (!dbUrl) throw new Error('DB_MIGRATION_URL / DB_URL is not set.');

    const tmpDir = await mkdtemp(join(tmpdir(), 'tzdata-'));
    const zipPath = join(tmpDir, 'timezones.zip');
    const client = new Client({ connectionString: dbUrl });

    try {
        await client.connect();

        const lockResult = await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1) AS locked',
            [ADVISORY_LOCK_KEY],
        );
        if (!lockResult.rows[0]?.locked) {
            status('skipped_locked_elsewhere');
            log('Another instance is already importing timezone data — skipping.');
            return;
        }

        try {
            status('downloading');
            await downloadAndVerify(zipPath);

            // Large multipolygons (Russia, Antarctica) can take longer to COPY
            // than the project's default statement_timeout. Set on the role
            // itself, not the session, for the same pooler reason as above.
            await client.query('ALTER ROLE CURRENT_USER SET statement_timeout = 0');

            log(`Truncating ${TZDATA_SCHEMA}.${TZDATA_TABLE}...`);
            await client.query(`TRUNCATE TABLE "${TZDATA_SCHEMA}"."${TZDATA_TABLE}"`);

            status('importing');
            log('Importing via ogr2ogr...');
            // GDAL's /vsizip/ virtual filesystem reads the geojson straight out
            // of the downloaded archive — no separate unzip step/dependency.
            const inputPath = `/vsizip/${zipPath}/${TIMEZONE_BOUNDARY_INNER_FILE}`;
            const { dsn, password } = buildPgConnectionString(dbUrl);
            const result = await ogr2ogr(inputPath, {
                format: 'PostgreSQL',
                destination: `PG:${dsn}`,
                env: { PGPASSWORD: password },
                skipFailures: false,
                timeout: 0,
                options: [
                    '-nln', `${TZDATA_SCHEMA}.${TZDATA_TABLE}`,
                    '-append',
                    '-nlt', 'PROMOTE_TO_MULTI',
                    '-lco', 'GEOMETRY_NAME=geom',
                    '-t_srs', 'EPSG:4326',
                    // NOT PG_USE_COPY=YES: appending via COPY writes an explicit
                    // NULL into the "id" column (its NOT NULL + sequence default
                    // only apply when a column is omitted from the row, and
                    // GDAL's COPY writer includes it anyway) — fails with
                    // "null value in column id violates not-null constraint".
                    // The regular INSERT path correctly omits unset-FID columns
                    // and lets the DB assign id via its default; ~450 rows makes
                    // the COPY speed advantage irrelevant here.
                    '--config', 'PG_USE_COPY', 'NO',
                ],
            });
            if (result.details) log(`ogr2ogr: ${result.details}`);
            status('completed');
            log('Import complete.');
        } finally {
            await client.query('ALTER ROLE CURRENT_USER RESET statement_timeout').catch(() => { });
            await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => { });
        }
    } finally {
        await client.end().catch(() => { });
        await rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
}

run().catch((err) => {
    log(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    // Rethrow as an unhandled rejection: Node's default (Node >=15) crashes
    // this worker thread on it, which surfaces as the parent Worker's 'error'
    // event — TzdataService never awaits this thread, so this is the only
    // channel back to it.
    throw err;
});
