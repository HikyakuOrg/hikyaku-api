import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class AddRouteDistance1789347600000 implements MigrationInterface {
    name = 'AddRouteDistance1789347600000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789347600000-add_route_distance.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "public"."vrp_route"
                DROP COLUMN IF EXISTS "distance_m",
                DROP COLUMN IF EXISTS "distance_source";
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."vrp_route_step"
                DROP COLUMN IF EXISTS "distance_m";
        `);
    }
}
