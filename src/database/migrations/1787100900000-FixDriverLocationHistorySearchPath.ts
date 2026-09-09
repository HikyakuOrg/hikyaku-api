import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class FixDriverLocationHistorySearchPath1787100900000 implements MigrationInterface {
    name = 'FixDriverLocationHistorySearchPath1787100900000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1787100900000-fix_driver_location_history_search_path.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores the pre-fix body verbatim, search_path included -- which is
        // the bug itself: with "extensions" off the path the geometry `=`
        // behind IS DISTINCT FROM cannot resolve, so every write to
        // driver_current_location aborts with SQLSTATE 42725.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."log_driver_location_history"()
                RETURNS trigger
                LANGUAGE plpgsql
                SET search_path TO 'public'
            AS $$
            begin
              if TG_OP = 'INSERT'
                 or (TG_OP = 'UPDATE' and NEW.location is distinct from OLD.location)
              then
                insert into public.driver_location_history (
                  driver_id,
                  location,
                  created_at
                )
                values (
                  NEW.driver_id,
                  NEW.location,
                  now()
                );
              end if;

              return NEW;
            end;
            $$;
        `);
        await queryRunner.query(`
            COMMENT ON FUNCTION "public"."log_driver_location_history"() IS NULL;
        `);
    }
}
