import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AllowStatusRevisits1787100100000 implements MigrationInterface {
    name = 'AllowStatusRevisits1787100100000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100100000-allow_status_revisits.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: the view and the function first (they only
        // read the constraint's guarantee, they do not depend on it), then the
        // duplicate rows this migration made legal, then the constraint itself.
        //
        // Restoring the constraint is destructive by necessity: any package that
        // revisited a status while it was gone now has rows the constraint
        // forbids, and there is no way to keep both. The oldest row per
        // (package_id, package_status) is kept -- that is the row that would
        // have existed had the constraint never been dropped, since ON CONFLICT
        // DO NOTHING kept the first write and discarded the rest.
        await queryRunner.query(`
            CREATE OR REPLACE VIEW "public"."packages_with_latest_status" WITH ("security_invoker"='on') AS
             SELECT "p"."id",
                "p"."created_at",
                "p"."delivery_notes",
                "p"."from_customer",
                "p"."to_customer",
                "p"."warehouse_id",
                "ps"."enums" AS "current_status",
                "w"."warehouse_name",
                "w"."warehouse_address",
                "extensions"."st_y"("w"."warehouse_location") AS "warehouse_lat",
                "extensions"."st_x"("w"."warehouse_location") AS "warehouse_lng"
               FROM ((("public"."packages" "p"
                 JOIN ( SELECT DISTINCT ON ("pt"."package_id") "pt"."package_id",
                        "pt"."package_status"
                       FROM "public"."package_timeline" "pt"
                      ORDER BY "pt"."package_id", "pt"."created_at" DESC) "latest" ON (("latest"."package_id" = "p"."id")))
                 JOIN "public"."package_status" "ps" ON (("ps"."id" = "latest"."package_status")))
                 LEFT JOIN "public"."warehouse" "w" ON (("w"."id" = "p"."warehouse_id")));
        `);
        await queryRunner.query(`
            DELETE FROM "public"."package_timeline" pt
             USING (
                 SELECT "id",
                        row_number() OVER (
                            PARTITION BY "package_id", "package_status"
                            ORDER BY "created_at" ASC, "id" ASC
                        ) AS rn
                   FROM "public"."package_timeline"
             ) dupes
             WHERE dupes."id" = pt."id"
               AND dupes.rn > 1;
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."package_timeline"
                ADD CONSTRAINT "package_timeline_package_status_unique"
                UNIQUE ("package_id", "package_status");
        `);
        // Last: an SQL-language body carrying ON CONFLICT needs the matching
        // unique constraint to exist before the body is accepted.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."insert_package_timeline"("p_package_id" "uuid", "p_status_enum" "text") RETURNS "void"
                LANGUAGE "sql"
                SET "search_path" TO 'public'
                AS $$
            insert into package_timeline (package_id, package_status)
            select p_package_id, id
            from package_status
            where enums = p_status_enum
            on conflict (package_id, package_status) do nothing;
            $$;
        `);
    }
}
