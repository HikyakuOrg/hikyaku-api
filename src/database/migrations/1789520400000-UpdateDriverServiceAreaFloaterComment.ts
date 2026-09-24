import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class UpdateDriverServiceAreaFloaterComment1789520400000 implements MigrationInterface {
    name = 'UpdateDriverServiceAreaFloaterComment1789520400000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1789520400000-update_driver_service_area_floater_comment.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores the comment CreateDriverServiceArea1788742800000 wrote.
        await queryRunner.query(`
            COMMENT ON TABLE "public"."driver_service_area" IS
                'Which delivery territories each driver covers. Many-to-many, and overlap is legitimate: a point inside two areas covered by two drivers returns both. A driver with NO rows here is a "floater" and is treated as covering everywhere, which is what keeps an empty table behaving exactly like the pre-service-area engine. See src/dispatch/coverage.ts.';
        `);
    }
}
