-- trg_prevent_manual_status_update / prevent_manual_status_update() reference
-- packages.current_status_id, a column that no longer exists — status is now
-- tracked via package_timeline + package_status (see packages_with_latest_status).
-- The trigger fires on every UPDATE to "packages", so any update (e.g.
-- OptimisationService.runAdhoc claiming packages via optimisation_id) throws
-- 42703 "record \"old\" has no field \"current_status_id\"".

DROP TRIGGER IF EXISTS "trg_prevent_manual_status_update" ON "public"."packages";
DROP FUNCTION IF EXISTS "public"."prevent_manual_status_update"();
