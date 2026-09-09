import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class FixTrackingNumberSpecialCharacters1789174800000 implements MigrationInterface {
    name = 'FixTrackingNumberSpecialCharacters1789174800000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1789174800000-fix_tracking_number_special_characters.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."generate_tracking_number"() RETURNS "text"
                LANGUAGE "plpgsql"
                SET "search_path" TO 'public', 'extensions'
                AS $$
            BEGIN
              RETURN to_char(clock_timestamp(), 'YYMMDD') ||
                     substr(
                       encode(gen_random_bytes(8), 'base64'),
                       1,
                       11
                     );
            END;
            $$;
        `);
    }
}
