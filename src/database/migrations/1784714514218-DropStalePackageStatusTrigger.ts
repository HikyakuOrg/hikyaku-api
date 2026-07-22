import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class DropStalePackageStatusTrigger1784714514218 implements MigrationInterface {
    name = 'DropStalePackageStatusTrigger1784714514218';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(this.read('1784714514218-drop_stale_package_status_trigger.sql'));
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."prevent_manual_status_update"() RETURNS "trigger"
                LANGUAGE "plpgsql"
                SET "search_path" TO 'public'
                AS $$
            BEGIN
                IF OLD.current_status_id IS DISTINCT FROM NEW.current_status_id THEN
                    RAISE EXCEPTION 'current_status_id cannot be updated directly';
                END IF;

                RETURN NEW;
            END;
            $$;
        `);
        await queryRunner.query(`
            ALTER FUNCTION "public"."prevent_manual_status_update"() OWNER TO "postgres";
        `);
        await queryRunner.query(`
            CREATE OR REPLACE TRIGGER "trg_prevent_manual_status_update"
                BEFORE UPDATE ON "public"."packages"
                FOR EACH ROW EXECUTE FUNCTION "public"."prevent_manual_status_update"();
        `);
    }
}
