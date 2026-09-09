import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class SplitDeadlineFromEta1787100200000 implements MigrationInterface {
    name = 'SplitDeadlineFromEta1787100200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100200000-split_deadline_from_eta.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Dropping the column discards every ETA written since. The deadlines in
        // scheduled_arrival are untouched by this migration, so nothing the
        // customer was promised is lost.
        await queryRunner.query(`
            ALTER TABLE "public"."package_delivery_window"
                DROP COLUMN IF EXISTS "estimated_arrival";
        `);
    }
}
