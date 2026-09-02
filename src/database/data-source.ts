import * as dotenv from 'dotenv';
import { types } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';
import { resolvePostgresSsl } from './postgres-ssl';

// The TypeORM CLI (migration:run / generate / revert) executes this file
// directly, WITHOUT booting Nest — so it never gets ConfigModule's env loading.
// Load the same files Nest does. dotenv never overrides variables already set in
// the real environment, so in production (where DB_URL is injected by the host)
// and when this module is imported by Nest, these calls are harmless no-ops.
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

// node-postgres's default DATE (oid 1082) parser converts to a JS Date at UTC
// midnight. Every raw `date` column read in this codebase (vrp_optimization
// .shift_date, chiefly) flows straight into a response DTO typed as a plain
// `YYYY-MM-DD` string — Nest's JSON serialiser then calls Date#toISOString()
// on it, silently turning "2026-09-02" into "2026-09-02T00:00:00.000Z" on the
// wire. That breaks clients that parse the field per its declared OpenAPI
// `format: date` (e.g. kotlinx.datetime.LocalDate rejects the trailing
// time-of-day as unparsed text). This registry is process-global in `pg`, so
// setting it once here — before any DataSource is created — fixes every call
// site for both the Nest app and the TypeORM CLI.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

/**
 * Shared TypeORM options, consumed by BOTH:
 *   - the NestJS app  — spread into TypeOrmModule.forRoot (see app.module.ts), and
 *   - the TypeORM CLI — via the default export below.
 *
 * IMPORTANT — the schema of this database is owned by Supabase, NOT TypeORM.
 * Tables, PostGIS columns, enums, RLS and the auth schema are provisioned
 * outside this repo, and our entities are only partial hand-mappings of a subset
 * of the real tables (see driver.entity.ts). Therefore:
 *
 *   - `synchronize` is hard-OFF. If it were ON, TypeORM would "correct" the live
 *     schema to match our entities and DROP every column/table it doesn't know
 *     about — i.e. it would destroy production data.
 *   - `migrationsRun` is OFF. Migrations are applied as an explicit, observable
 *     deploy step (`pnpm migration:run`), never silently on app boot. This keeps
 *     migration decoupled from rollout and safe under multiple instances.
 *
 * See src/database/README.md for the full workflow and the baseline rationale.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  // App connection — unchanged from before (the running app keeps using DB_URL).
  url: process.env.DB_URL,
  // SSL turns on only when DB_SSL_CA_PATH names a CA cert that's actually on
  // disk; otherwise this is undefined and the connection stays plain TCP.
  // See postgres-ssl.ts for why a bare `ssl: true` isn't enough for Supabase.
  ssl: resolvePostgresSsl(),
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  // Schema-qualified (not the top-level `schema` option) so ONLY the ledger
  // table moves — the top-level option would silently default every entity
  // without its own @Entity({schema}) into hikyaku_migrations too.
  // Requires `CREATE SCHEMA IF NOT EXISTS "hikyaku_migrations"` to already
  // exist in the target database (see infra/db/schema.sql) — TypeORM does
  // not create the schema itself, only the table within it.
  migrationsTableName: 'hikyaku_migrations.typeorm_migrations',
  synchronize: false,
  migrationsRun: false,
};

/**
 * Standalone DataSource for the TypeORM CLI.
 *
 * Differences from the app config:
 *   - Prefers DB_MIGRATION_URL when set. Point this at Supabase's DIRECT
 *     connection (port 5432), NOT the 6543 transaction pooler — DDL, advisory
 *     locks and prepared statements are unreliable under transaction pooling.
 *   - Lists entities via a glob, because `autoLoadEntities` is a Nest-only
 *     feature and is unavailable to the CLI.
 */
export default new DataSource({
  ...dataSourceOptions,
  url: process.env.DB_MIGRATION_URL ?? process.env.DB_URL,
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
});
