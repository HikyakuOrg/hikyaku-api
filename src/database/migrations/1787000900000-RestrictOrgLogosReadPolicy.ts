import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class RestrictOrgLogosReadPolicy1787000900000 implements MigrationInterface {
    name = 'RestrictOrgLogosReadPolicy1787000900000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000900000-restrict_org_logos_read_policy.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_team_read" ON "storage"."objects";
        `);
        await queryRunner.query(`
            CREATE POLICY "org_logos_public_read"
                ON "storage"."objects" FOR SELECT
                TO "public"
                USING (bucket_id = 'org-logos');
        `);
    }
}
