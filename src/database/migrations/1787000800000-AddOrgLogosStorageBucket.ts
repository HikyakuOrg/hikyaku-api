import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddOrgLogosStorageBucket1787000800000 implements MigrationInterface {
    name = 'AddOrgLogosStorageBucket1787000800000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000800000-add_org_logos_storage_bucket.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: policies depend on the bucket existing,
        // and the bucket row can't be removed while objects still reference
        // it as a foreign key, so every uploaded logo goes first.
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_team_delete" ON "storage"."objects";
        `);
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_team_update" ON "storage"."objects";
        `);
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_team_insert" ON "storage"."objects";
        `);
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_public_read" ON "storage"."objects";
        `);
        await queryRunner.query(`
            DELETE FROM "storage"."objects" WHERE bucket_id = 'org-logos';
        `);
        await queryRunner.query(`
            DELETE FROM "storage"."buckets" WHERE id = 'org-logos';
        `);
    }
}
