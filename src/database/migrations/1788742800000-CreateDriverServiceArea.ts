import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CreateDriverServiceArea1788742800000 implements MigrationInterface {
    name = 'CreateDriverServiceArea1788742800000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1788742800000-create_driver_service_area.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: the table (which takes its policies, indexes
        // and foreign keys with it), then the two parent unique constraints,
        // which cannot be dropped while the composite FKs still reference them.

        // Policies and indexes are owned by the table and are dropped with it.
        // Spelling them out separately would only create a window in which a
        // half-reverted table sits there with RLS enabled and no policy, which
        // reads as "deny everything" to authenticated and is a worse state to be
        // interrupted in than either end.
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."driver_service_area"`,
        );

        // Guarded because ALTER TABLE ... DROP CONSTRAINT IF EXISTS is fine on a
        // missing constraint but not on a missing table, and because these two
        // are the only part of this migration that touched a table it did not
        // create. If something else has since referenced either constraint the
        // DROP fails loudly, which is correct: silently removing the target of
        // somebody else's foreign key is not a revert.
        await queryRunner.query(`
            ALTER TABLE "public"."service_areas"
                DROP CONSTRAINT IF EXISTS "service_areas_id_organisation_id_key";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."drivers"
                DROP CONSTRAINT IF EXISTS "drivers_id_organisation_id_key";
        `);
    }
}
