import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class CreateSkillsSchema1789261500000 implements MigrationInterface {
    name = 'CreateSkillsSchema1789261500000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789261500000-create_skills_schema.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: the two join tables (which take their
        // policies, indexes and foreign keys with them), then the catalog
        // table itself, then the two parent unique constraints, which cannot
        // be dropped while the join tables' composite FKs still reference
        // them.
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."package_skills"`,
        );
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."vehicle_skills"`,
        );
        await queryRunner.query(`DROP TABLE IF EXISTS "public"."skills"`);

        // Guarded because ALTER TABLE ... DROP CONSTRAINT IF EXISTS is fine on
        // a missing constraint but not on a missing table, and because these
        // two are the only part of this migration that touched a table it
        // did not create. If something else has since referenced either
        // constraint the DROP fails loudly, which is correct: silently
        // removing the target of somebody else's foreign key is not a
        // revert.
        await queryRunner.query(`
            ALTER TABLE "public"."packages"
                DROP CONSTRAINT IF EXISTS "packages_id_organisation_id_key";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."vehicles"
                DROP CONSTRAINT IF EXISTS "vehicles_id_organisation_id_key";
        `);
    }
}
