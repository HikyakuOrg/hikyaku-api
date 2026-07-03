import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class CreateOptimisationRun1783037652000 implements MigrationInterface {
    name = 'CreateOptimisationRun1783037652000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(this.read('1783037652000-create_optimisation_run.sql'));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "public"."optimisation_run"`);
    }
}
