import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class Baseline0000000000000 implements MigrationInterface {
    name = 'Baseline0000000000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        const sql = this.read('0000000000000-baseline.sql');
        // Comment-only baseline → nothing to run. Guards against an empty query.
        if (sql) {
            await queryRunner.query(sql);
        }
    }

    public async down(): Promise<void> {
        // Baseline is the ledger origin — there is nothing to revert.
    }
}
