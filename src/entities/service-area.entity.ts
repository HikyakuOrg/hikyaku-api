import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A delivery territory: the polygon a dispatcher draws so that packages to an
 * address inside it route to the driver who covers it, rather than to whichever
 * van happens to be the cheapest detour.
 *
 * Written exclusively by the web dashboard, straight through PostgREST under
 * RLS. hikyaku-api only ever reads this table, so nothing here is a write
 * model, and no relation decorators are declared (this codebase keeps its
 * dispatch-hot-path joins in raw SQL and uses entities mainly for typing).
 *
 * Two rules that the database will NOT enforce for you:
 *
 *  1. SOFT DELETE IS A QUERY-LAYER CONCERN. `is_deleted` is filtered in the
 *     query, never in the RLS SELECT policy, exactly as `vehicles.is_deleted`
 *     is (see AssignmentService.loadCandidates / openShift and
 *     DatabaseService, which all spell out `AND v.is_deleted = false`). Every
 *     read of this table must say `AND is_deleted = false` itself. A coverage
 *     lookup that forgets will route packages into a retired territory.
 *
 *  2. CONTAINMENT PREDICATES MUST SET THE SRID ON BOTH SIDES.
 *     `service_areas.geometry` is guaranteed SRID 4326 by
 *     service_areas_geometry_srid_chk, but `customer.customer_location` is a
 *     bare `extensions.geometry` with no typmod, i.e. SRID 0. Comparing them
 *     directly raises "Operation on mixed SRID geometries", the same failure
 *     FixWarehouseTimezoneSrid1787100700000 fixed for warehouses. Write:
 *
 *       extensions.st_covers(
 *           extensions.st_setsrid(sa.geometry, 4326),
 *           extensions.st_setsrid(c.customer_location, 4326))
 */
@Entity('service_areas')
export class ServiceArea {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'name', type: 'text' })
    name: string;

    /**
     * The territory itself. In the database this is
     * `extensions.geometry(MultiPolygon, 4326)`, multi-part so one named area
     * can cover disjoint pieces (a suburb plus the island off it, or a zone
     * split by a river). It is additionally constrained to be valid, non-zero
     * area, within +/-180 by +/-90, and at most 10000 vertices.
     *
     * Typed as `string`, and deliberately NOT declared as TypeORM's spatial
     * `geometry` column type, for two reasons. TypeORM's spatial handling emits
     * a bare, unqualified `ST_AsGeoJSON(...)` in its generated SELECTs, and
     * PostGIS lives in the `extensions` schema here, so that does not reliably
     * resolve. And the value a plain repository read actually returns is the
     * hex EWKB the pg driver hands back verbatim
     * ("0106000020E6100000..."), which is a `string` and is useless as one.
     *
     * ALWAYS READ THIS COLUMN THROUGH `ST_AsGeoJSON(...)` IN RAW SQL. Never
     * round-trip it through a repository find().
     */
    @Column({ name: 'geometry', type: 'text' })
    geometry: string;

    @Column({ name: 'organisation_id', type: 'uuid' })
    organisationId: string;

    /**
     * Both timestamps are owned by the database, not by the application:
     * `created_at` by its column DEFAULT, `updated_at` by the
     * `service_areas_touch` BEFORE UPDATE trigger. They are plain @Column
     * rather than @CreateDateColumn / @UpdateDateColumn so TypeORM cannot write
     * either of them from here, mirroring how VrpOptimization maps its own
     * trigger-maintained `updated_at`.
     */
    @Column({ name: 'created_at', type: 'timestamptz' })
    createdAt: Date;

    @Column({ name: 'updated_at', type: 'timestamptz' })
    updatedAt: Date;

    /** See rule 1 in the class doc: filter this explicitly on every read. */
    @Column({ name: 'is_deleted', type: 'boolean', default: false })
    isDeleted: boolean;
}
