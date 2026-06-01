/**
 * Backfill: intended to run BEFORE migration 0015 is applied, to create Stripe
 * Customer objects for existing DB customers while their PII columns still exist.
 *
 * After 0015 drops the PII columns, historical customer PII is gone from the DB
 * and this script is a no-op. Run it against each environment before applying
 * the migration.
 *
 * Usage (before 0015):
 *   npx ts-node -r tsconfig-paths/register src/customers/backfill.ts
 */

console.log(
    'Backfill: migration 0015 drops all PII columns. ' +
    'This script must be run before applying 0015 in environments with existing customers. ' +
    'After 0015, there is nothing to backfill — Stripe is the source of truth from the first write.',
);

process.exit(0);
