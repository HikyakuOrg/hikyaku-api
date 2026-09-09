import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class ReserveInfraSlugs1786517114000 implements MigrationInterface {
    name = 'ReserveInfraSlugs1786517114000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1786517114000-reserve_infra_slugs.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores the pre-migration `GRANT ALL` breadth. A bare REVOKE UPDATE
        // clears the column-level grants too, so the table-level GRANT that
        // follows puts every column back in reach.
        await queryRunner.query(`
            REVOKE UPDATE ON TABLE "public"."organisations" FROM "authenticated";
        `);
        await queryRunner.query(`
            GRANT UPDATE ON TABLE "public"."organisations" TO "authenticated";
        `);
        await queryRunner.query(`
            GRANT UPDATE ON TABLE "public"."organisations" TO "anon";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."organisations"
                DROP CONSTRAINT IF EXISTS "organisations_slug_not_reserved_check";
        `);
    }
}
