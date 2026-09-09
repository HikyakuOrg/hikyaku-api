import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddSignaturePodSupport1788569652000 implements MigrationInterface {
    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1788569652000-add_signature_pod_support.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: policies first, then the seeded lookup rows.
        await queryRunner.query(
            `drop policy if exists "packages_bucket_update_non_signature" on "storage"."objects"`,
        );
        await queryRunner.query(
            `drop policy if exists "packages_bucket_select" on "storage"."objects"`,
        );
        await queryRunner.query(
            `drop policy if exists "packages_bucket_insert" on "storage"."objects"`,
        );
        await queryRunner.query(
            `delete from "public"."pod_type" where id in (2, 3)`,
        );
    }
}
