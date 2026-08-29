-- Lets a package hold the same status more than once, so ASSIGNED → PENDING →
-- ASSIGNED becomes expressible.
--
-- package_timeline_package_status_unique UNIQUE(package_id, package_status) made
-- a status a set membership rather than a history. That already breaks un-assign
-- today: the web route-adjustment action calls insert_package_timeline(PENDING)
-- when a dispatcher pulls a package off a shift and it silently no-ops, so the
-- package reads ASSIGNED forever. Eviction -- the whole point of instant
-- assignment's last-resort path -- would inherit the same silent failure.
--
-- EVERYTHING THAT DEPENDS ON THE CONSTRAINT IS REPAIRED IN THIS SAME FILE. This
-- is deliberate and must stay that way:
--
--   * insert_package_timeline() carries `on conflict (package_id, package_status)
--     do nothing`. ON CONFLICT needs a matching unique index; the moment the
--     constraint is gone that clause raises SQLSTATE 42P10 ("there is no unique
--     or exclusion constraint matching the ON CONFLICT specification") on EVERY
--     status write from all three clients. Splitting the drop and the redefine
--     across two migrations means a window where the app is hard down.
--
--   * packages_with_latest_status resolves the current status with
--     DISTINCT ON (pt.package_id) ORDER BY pt.package_id, pt.created_at DESC --
--     and no tiebreak. That was safe only because the constraint made duplicates
--     impossible. Allow duplicates and it starts returning an arbitrary row of
--     whichever share a created_at, which on the dashboard and the driver app
--     looks like a package randomly flipping between statuses. package_timeline.id
--     is UUIDv7 (see PackageTimelineUuidPkAndRealtime) so `, pt.id DESC` restores
--     a deterministic newest-first order, matching what every other latest-status
--     query in the codebase already does.
--
-- The matching TypeScript change (DatabaseService.insertPackageTimelineStatus
-- dropping its own ON CONFLICT) ships in the same commit.

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- ── 1. Drop the constraint ───────────────────────────────────────────────────

ALTER TABLE "public"."package_timeline"
    DROP CONSTRAINT IF EXISTS "package_timeline_package_status_unique";

-- idx_package_timeline_package (package_id, package_status) is a plain index and
-- survives: get_packages_count() and the RLS helpers still filter on it.

-- ── 2. insert_package_timeline: latest-status guard ──────────────────────────
--
-- The ON CONFLICT was providing idempotency, not history-suppression: callers
-- re-stamping the status a package already holds should be a no-op. A
-- latest-status guard keeps exactly that and nothing more, so a package that
-- left ASSIGNED and came back records both visits.
--
-- Two concurrent calls can still both observe "not currently at this status" and
-- both insert. That is now harmless rather than an error: duplicate rows are
-- legal, and every latest-status reader breaks the tie on (created_at, id).

CREATE OR REPLACE FUNCTION "public"."insert_package_timeline"("p_package_id" "uuid", "p_status_enum" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
    v_status_id bigint;
    v_latest_id bigint;
BEGIN
    SELECT ps.id INTO v_status_id
      FROM package_status ps
     WHERE ps.enums = p_status_enum;

    -- Unknown enum: the previous INSERT ... SELECT wrote no row and raised
    -- nothing. Keep that, so a typo stays a silent no-op rather than a new
    -- failure mode for callers that never had to handle one.
    IF v_status_id IS NULL THEN
        RETURN;
    END IF;

    SELECT pt.package_status INTO v_latest_id
      FROM package_timeline pt
     WHERE pt.package_id = p_package_id
     ORDER BY pt.created_at DESC, pt.id DESC
     LIMIT 1;

    IF v_latest_id IS NOT DISTINCT FROM v_status_id THEN
        RETURN;
    END IF;

    INSERT INTO package_timeline (package_id, package_status)
    VALUES (p_package_id, v_status_id);
END;
$$;

COMMENT ON FUNCTION "public"."insert_package_timeline"("uuid", "text") IS
    'Appends a package_timeline row unless the package already holds that status. Replaces the ON CONFLICT (package_id, package_status) DO NOTHING that AllowStatusRevisits removed the constraint for.';

-- ── 3. packages_with_latest_status: add the missing tiebreak ─────────────────
--
-- The column list below is reproduced verbatim from the live definition. The web
-- dashboard's generated Database type and the mobile app's reads are both keyed
-- to it, so the ONLY change here is `, pt.id DESC` inside the DISTINCT ON
-- subquery. CREATE OR REPLACE VIEW cannot change an existing column's name,
-- position or type -- keeping the list identical is what makes this a
-- replace rather than a drop-and-recreate that would take every dependent
-- grant and policy with it.

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
          ORDER BY "pt"."package_id", "pt"."created_at" DESC, "pt"."id" DESC) "latest" ON (("latest"."package_id" = "p"."id")))
     JOIN "public"."package_status" "ps" ON (("ps"."id" = "latest"."package_status")))
     LEFT JOIN "public"."warehouse" "w" ON (("w"."id" = "p"."warehouse_id")));

COMMENT ON VIEW "public"."packages_with_latest_status" IS
    'Packages with their current status. The DISTINCT ON breaks ties on (created_at DESC, id DESC) -- package_timeline.id is UUIDv7, so that is newest-first even for rows sharing a timestamp.';
