--
-- Context: the floater rule now ignores links to retired service areas.
--
-- Retiring a service area is a soft delete (service_areas.is_deleted = true)
-- and deliberately keeps its driver_service_area rows, so the area can be
-- un-retired with the same drivers. The floater probe in
-- src/dispatch/coverage.ts used to count those rows, which left a driver whose
-- only area was retired neither a floater nor covering any point: reachable
-- only through the fallback steps, while the driver page (which lists live
-- areas only) called them a floater. The probe now counts links to live areas
-- only, so that driver is a floater again.
--
-- No data or schema changes. This only restates the rule in the table's own
-- COMMENT, which is one of the three places it is written down (with
-- applyFloaterRule in coverage.ts and DriverServiceArea's class doc).

COMMENT ON TABLE "public"."driver_service_area" IS
    'Which delivery territories each driver covers. Many-to-many, and overlap is legitimate: a point inside two areas covered by two drivers returns both. A driver with NO rows here pointing at a live (is_deleted = false) service area is a "floater" and is treated as covering everywhere, which is what keeps an empty table behaving exactly like the pre-service-area engine. Rows pointing at a retired area are kept so it can be un-retired, and do not count. See src/dispatch/coverage.ts.';
