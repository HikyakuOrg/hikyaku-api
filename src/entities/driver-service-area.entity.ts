import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Which delivery territories a driver covers.
 *
 * The many-to-many between `drivers` and `service_areas`, and the join every
 * coverage question in dispatch goes through: given an organisation, a warehouse
 * and a point, which drivers cover it?
 *
 * Written exclusively by the web dashboard, straight through PostgREST under
 * RLS, exactly like `service_areas`. hikyaku-api only ever reads it, so nothing
 * here is a write model, and no relation decorators are declared (this codebase
 * keeps its dispatch-hot-path joins in raw SQL and uses entities mainly for
 * typing). The one reader is `src/dispatch/coverage.ts`.
 *
 * ── THE FLOATER RULE ────────────────────────────────────────────────────────
 *
 * A DRIVER WITH NO ROWS IN THIS TABLE COVERS EVERYWHERE.
 *
 * This is the single most consequential rule in the whole coverage feature and
 * it is not visible in the schema, so it is written here, in
 * `src/dispatch/coverage.ts` (as `applyFloaterRule`, which implements it), and
 * in the table's own COMMENT. It reads "no areas means unrestricted", not "no
 * areas means ineligible".
 *
 * The reason is day one. The strict reading is defensible in the abstract, but
 * on the morning this ships every driver in every organisation has zero rows
 * here, so under the strict reading every driver is ineligible for every package
 * and the entire fleet stops. The permissive reading makes an empty table
 * behave byte-identically to the engine as it exists today, which is the hard
 * requirement this feature was built against, and it degrades gracefully
 * forever: a dispatcher who staffs three of their eight drivers gets exactly the
 * behaviour they asked for, with the other five still able to take anything.
 *
 * "Floater" and "explicitly covers" are different states, not one merged answer,
 * and a coverage diagnostic has to be able to tell a dispatcher which one it is
 * looking at. `coverage.ts` therefore returns them as separate fields rather
 * than as one already-unioned set.
 *
 * ── TWO TRAPS INHERITED FROM service_areas ──────────────────────────────────
 *
 *  1. SOFT DELETE IS A QUERY-LAYER CONCERN, AND IT LIVES ON THE OTHER TABLE.
 *     There is no `is_deleted` here. A row in this table pointing at a
 *     soft-deleted service area is still present and still readable, because
 *     retiring a territory deliberately keeps its staffing so it can be
 *     un-retired. Every read that resolves coverage MUST therefore join
 *     `service_areas` and spell out `AND sa.is_deleted = false` itself, exactly
 *     as `ServiceArea` rule 1 and `vehicles.is_deleted` require. Forgetting it
 *     routes packages into a territory the dispatcher retired months ago.
 *
 *  2. CONTAINMENT PREDICATES MUST SET THE SRID ON BOTH SIDES.
 *     `service_areas.geometry` is guaranteed SRID 4326 by
 *     service_areas_geometry_srid_chk, but `customer.customer_location`, the
 *     likely source of the point being tested, is a bare `extensions.geometry`
 *     with no typmod, i.e. SRID 0. Mixing them raises "Operation on mixed SRID
 *     geometries". See `ServiceArea` rule 2, and see `coverage.ts` for how that
 *     is reconciled with keeping the GIST index usable (the short version: the
 *     indexed column stays bare inside the bounding-box operator, and the point
 *     is constructed with its SRID already on it).
 *
 * ── CROSS-TENANT INTEGRITY ──────────────────────────────────────────────────
 *
 * `organisationId` is not a client-trusted denormalisation. Composite foreign
 * keys to `drivers(id, organisation_id)` and `service_areas(id, organisation_id)`
 * make a value that disagrees with either parent impossible to insert, for every
 * role including `service_role`, which bypasses RLS. That is why it is safe for
 * the RLS policies to hand this column straight to `has_org_permission()`. See
 * CreateDriverServiceArea1788742800000 for why that was chosen over the
 * `driver_vehicle_same_org()` pattern `driver_vehicle_assignment` uses.
 *
 * ── DELETES ─────────────────────────────────────────────────────────────────
 *
 * Both foreign keys are ON DELETE CASCADE, so deleting a driver or hard-deleting
 * a service area silently drops the pairing with no trace. Nothing reads this
 * table for history, so that is currently harmless, but it is the reason a
 * "where did this driver's coverage go" question has no answer in the database.
 */
@Entity('driver_service_area')
export class DriverServiceArea {
    /**
     * Half of the composite primary key. `drivers.id` is itself
     * `auth.users.id`, so this is also the driver's user id.
     */
    @PrimaryColumn({ name: 'driver_id', type: 'uuid' })
    driverId: string;

    /** The other half of the composite primary key. */
    @PrimaryColumn({ name: 'service_area_id', type: 'uuid' })
    serviceAreaId: string;

    /**
     * The organisation both parents belong to. See the cross-tenant section in
     * the class doc: this is structurally guaranteed to match both, not merely
     * expected to.
     */
    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    /**
     * Owned by the database's column DEFAULT, not by the application. A plain
     * @Column rather than @CreateDateColumn so TypeORM cannot write it from
     * here, matching how ServiceArea maps its own timestamps.
     *
     * There is deliberately no `updated_at` and no touch trigger. Every column
     * on this table except this one is part of the primary key or is pinned to
     * it by a foreign key, so there is nothing an UPDATE could change that would
     * not be better expressed as a delete plus an insert.
     */
    @Column({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;
}
