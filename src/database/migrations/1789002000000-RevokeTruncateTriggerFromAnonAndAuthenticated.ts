import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class RevokeTruncateTriggerFromAnonAndAuthenticated1789002000000 implements MigrationInterface {
    name = 'RevokeTruncateTriggerFromAnonAndAuthenticated1789002000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1789002000000-revoke_truncate_trigger_from_anon_and_authenticated.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores the pre-HIK-33 posture: TRUNCATE and TRIGGER back on every
        // table in public for the two PostgREST roles, and back in the
        // default-privileges rule so future tables reacquire them.
        //
        // Two honest imperfections, both inherent to reverting a schema-wide
        // grant:
        //   - GRANT ON ALL TABLES is a superset. Tables created between `up`
        //     and this revert never carried the bits (their default
        //     privileges no longer included them, and the per-table revokes
        //     predate them); this hands the bits to them anyway. A revert is
        //     an emergency tool, not a time machine.
        //   - The supabase_admin shadow rule is re-granted best-effort with
        //     the same guards as `up`: if the role is gone or the migration
        //     connection cannot alter its default privileges, the revert
        //     proceeds — matching however far `up` actually got.
        await queryRunner.query(`
            GRANT TRUNCATE, TRIGGER ON ALL TABLES IN SCHEMA "public" TO "anon", "authenticated";
        `);
        await queryRunner.query(`
            ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"
                GRANT TRUNCATE, TRIGGER ON TABLES TO "anon", "authenticated";
        `);
        await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
                    ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public"
                        GRANT TRUNCATE, TRIGGER ON TABLES TO "anon", "authenticated";
                END IF;
            EXCEPTION
                WHEN insufficient_privilege OR undefined_object THEN
                    NULL;
            END
            $$;
        `);
    }
}
