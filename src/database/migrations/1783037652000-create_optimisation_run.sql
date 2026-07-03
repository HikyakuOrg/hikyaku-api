-- Creates optimisation_run, the table backing OptimisationService's on-demand
-- run tracking (5-minute per-org rate limit + async status polling).
--
-- This table is app-owned (hikyaku-api is the only writer), so unlike most of
-- the schema it lives in a TypeORM migration rather than infra/db/schema.sql.

CREATE TABLE IF NOT EXISTS "public"."optimisation_run" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organisation_id" "uuid" NOT NULL,
    "warehouse_id" "uuid",
    "trigger" "text" DEFAULT 'manual'::"text" NOT NULL,
    "requested_by" "uuid",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "optimisation_id" "uuid",
    "error" "text",
    CONSTRAINT "optimisation_run_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."optimisation_run" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "optimisation_run_organisation_id_requested_at_idx"
    ON "public"."optimisation_run" USING "btree" ("organisation_id", "requested_at" DESC);

-- Written exclusively by hikyaku-api over its service-role connection, which
-- bypasses RLS. The dashboard only needs SELECT, gated the same way as the
-- analogous scheduler_runs table.
ALTER TABLE "public"."optimisation_run" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "optimisation run select org" ON "public"."optimisation_run"
    FOR SELECT TO "authenticated"
    USING ("public"."has_org_permission"("organisation_id", 'shifts.view'::"text"));

GRANT ALL ON TABLE "public"."optimisation_run" TO "anon";
GRANT ALL ON TABLE "public"."optimisation_run" TO "authenticated";
GRANT ALL ON TABLE "public"."optimisation_run" TO "service_role";
