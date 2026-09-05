import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class DropSchedulerRuns1787100500000 implements MigrationInterface {
    name = 'DropSchedulerRuns1787100500000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787100500000-drop_scheduler_runs.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Recreates the table as it stood, with its constraints, index, grants
        // and RLS policy -- reproduced from infra/db/schema.sql. The ROWS are
        // gone for good; nothing read them, and inventing history would be
        // worse than not having it.
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "public"."scheduler_runs" (
                "id" uuid DEFAULT gen_random_uuid() NOT NULL,
                "warehouse_id" uuid NOT NULL,
                "run_date" date DEFAULT CURRENT_DATE NOT NULL,
                "ran_at" timestamptz DEFAULT now() NOT NULL,
                "status" text DEFAULT 'pending'::text NOT NULL,
                "retry_count" integer DEFAULT 0 NOT NULL,
                "organisation_id" uuid NOT NULL
            );
        `);
        await queryRunner.query(`
            ALTER TABLE ONLY "public"."scheduler_runs"
                ADD CONSTRAINT "scheduler_runs_pkey" PRIMARY KEY ("id");
        `);
        await queryRunner.query(`
            ALTER TABLE ONLY "public"."scheduler_runs"
                ADD CONSTRAINT "scheduler_runs_warehouse_id_run_date_key"
                UNIQUE ("warehouse_id", "run_date");
        `);
        await queryRunner.query(`
            ALTER TABLE ONLY "public"."scheduler_runs"
                ADD CONSTRAINT "scheduler_runs_organisation_id_fkey"
                FOREIGN KEY ("organisation_id")
                REFERENCES "public"."organisations"("id") ON DELETE CASCADE;
        `);
        await queryRunner.query(`
            ALTER TABLE ONLY "public"."scheduler_runs"
                ADD CONSTRAINT "scheduler_runs_warehouse_id_fkey"
                FOREIGN KEY ("warehouse_id")
                REFERENCES "public"."warehouse"("id") ON DELETE CASCADE;
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "scheduler_runs_organisation_id_idx"
                ON "public"."scheduler_runs" USING btree ("organisation_id");
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."scheduler_runs" ENABLE ROW LEVEL SECURITY;
        `);
        await queryRunner.query(`
            CREATE POLICY "scheduler runs select org"
                ON "public"."scheduler_runs" FOR SELECT TO "authenticated"
                USING ("public"."has_org_permission"("organisation_id", 'shifts.view'::text));
        `);
        await queryRunner.query(`
            GRANT ALL ON TABLE "public"."scheduler_runs" TO "anon";
        `);
        await queryRunner.query(`
            GRANT ALL ON TABLE "public"."scheduler_runs" TO "authenticated";
        `);
        await queryRunner.query(`
            GRANT ALL ON TABLE "public"."scheduler_runs" TO "service_role";
        `);
    }
}
