import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class LimitPersonalOrgWarehouses1786790000000
    implements MigrationInterface
{
    name = 'LimitPersonalOrgWarehouses1786790000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1786790000000-limit_personal_org_warehouses.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: the trigger depends on the function.
        //
        // Reverting only lifts the cap. It cannot undo the effect of having had
        // it, because the .sql deletes nothing on the way in -- personal orgs
        // that were blocked from adding a second warehouse simply become able to
        // again, and re-running the up migration afterwards is safe against
        // whatever they added in the meantime (those rows are grandfathered, the
        // same as any that predated the cap).
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "warehouse_personal_org_limit"
                ON "public"."warehouse";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."enforce_personal_org_warehouse_limit"();
        `);
    }
}
