import { Client } from 'pg';
import {
    coveringDriversForPoint,
    coveringDriversForPoints,
    type CoverageQueryExecutor,
} from '../src/dispatch/coverage';

/**
 * The half of coverage that only a real PostGIS can answer.
 *
 * Everything testable without a database is in src/dispatch/coverage.spec.ts and
 * runs under `pnpm test`. This file needs live geometry (does this point fall
 * inside this polygon, is a point on a shared boundary covered, does a
 * soft-deleted area drop out) and live RLS and foreign keys, so it lives under
 * test/ and runs only under `pnpm test:e2e`.
 *
 * ── HOW TO RUN IT, AND THE SAFETY PROPERTY THAT MAKES THAT OK ───────────────
 *
 * It needs DB_MIGRATION_URL (preferred, the direct 5432 connection) or DB_URL,
 * pointing at a database with this repo's migrations applied, and connecting as
 * a role that owns the public schema, normally `postgres`. Without one the whole
 * suite skips rather than failing, so a checkout with no database configured
 * stays green.
 *
 * EVERY TEST RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK. Nothing
 * here commits, including the fixtures. That is deliberate and it is not
 * optional: the DB_URL in a working checkout of this repo points at a real
 * Supabase project rather than an ephemeral container, and a test suite that
 * leaves half a tenant behind in one is a bad trade for any amount of
 * convenience. Rows that must fail to insert are attempted inside a SAVEPOINT,
 * because a failed statement aborts the surrounding transaction and would take
 * the rest of the test with it.
 *
 * Fixtures reach into auth.users, because drivers.id is a foreign key to it, and
 * they set request.jwt.claims before inserting an organisation, because
 * handle_new_organisation() raises when auth.uid() is null. That trigger also
 * grants the creator every permission in the new organisation, which is where
 * the service_areas.edit permission these tests rely on comes from.
 */

const DB_URL = process.env.DB_MIGRATION_URL ?? process.env.DB_URL;

// describe.skip rather than a failure: no database configured is a normal state
// for this repo, not a broken one.
const describeWithDb = DB_URL ? describe : describe.skip;

/** Squares on the equator, so a failing assertion is about coverage, not trig. */
const WEST = 'MULTIPOLYGON(((0 0, 0 10, 10 10, 10 0, 0 0)))';
const EAST = 'MULTIPOLYGON(((10 0, 10 10, 20 10, 20 0, 10 0)))';
/** Straddles the WEST/EAST seam, so points in 5..10 fall inside two areas. */
const STRADDLE = 'MULTIPOLYGON(((5 0, 5 10, 15 10, 15 0, 5 0)))';

const INSIDE_WEST = { lon: 2, lat: 5 };
const INSIDE_BOTH = { lon: 7, lat: 5 };
/** Exactly on the shared edge of WEST and EAST. ST_Contains would miss this. */
const ON_SEAM = { lon: 10, lat: 5 };
const OUTSIDE_EVERYTHING = { lon: 100, lat: 40 };

interface Tenant {
    organisationId: string;
    warehouseId: string;
    ownerId: string;
}

/**
 * The three methods of `pg.Client` this file uses.
 *
 * `pg` ships no type declarations and `@types/pg` is not a dependency of this
 * repo, so the imported `Client` resolves to nothing and every call on it is an
 * `@typescript-eslint/no-unsafe-call` error. src/dispatch/pg-notify.service.ts
 * carries about twenty of those today for exactly that reason. Adding the types
 * package is the real fix and is a dependency change no test should be making,
 * so the surface actually used is declared here and the constructor is narrowed
 * to it once, below.
 */
interface PgClient {
    connect(): Promise<void>;
    end(): Promise<void>;
    query<R = unknown>(
        text: string,
        values?: unknown[],
    ): Promise<{ rows: R[] }>;
}

const PgClientCtor = Client as unknown as new (config: {
    connectionString: string;
}) => PgClient;

describeWithDb('coverage against a real database', () => {
    jest.setTimeout(60_000);

    let client: PgClient;
    /** Counts round trips, so the batch form can be proven to make exactly one. */
    let roundTrips: number;
    let executor: CoverageQueryExecutor;

    beforeAll(async () => {
        // Non-null assertion: DB_URL is only ever undefined when describeWithDb
        // is describe.skip, in which case nothing in this block runs at all.
        client = new PgClientCtor({ connectionString: DB_URL! });
        await client.connect();
    });

    afterAll(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('BEGIN');
        roundTrips = 0;
        executor = {
            async query(sql: string, parameters?: unknown[]): Promise<unknown> {
                roundTrips++;
                // TypeORM's DataSource.query already returns the row array; the
                // raw pg driver returns a result object, so unwrap it here.
                const result = await client.query(sql, parameters);
                return result.rows;
            },
        };
    });

    afterEach(async () => {
        await client.query('ROLLBACK');
    });

    // ── Fixtures ─────────────────────────────────────────────────────────────

    async function createUser(): Promise<string> {
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO auth.users (id, email)
             VALUES (gen_random_uuid(), gen_random_uuid()::text || '@coverage.test')
             RETURNING id`,
        );
        return rows[0].id;
    }

    /** An organisation with a warehouse, created by a user who owns it. */
    async function createTenant(): Promise<Tenant> {
        const ownerId = await createUser();

        // handle_new_organisation() reads auth.uid() and raises when it is null,
        // so the claim has to be in place even though this connection is not
        // actually running as `authenticated`.
        await actAs(ownerId);
        const { rows: orgs } = await client.query<{ id: string }>(
            `INSERT INTO organisations (name, org_type, created_by)
             VALUES ('coverage-' || gen_random_uuid()::text, 'company', $1)
             RETURNING id`,
            [ownerId],
        );
        const organisationId = orgs[0].id;

        const { rows: warehouses } = await client.query<{ id: string }>(
            `INSERT INTO warehouse (warehouse_name, warehouse_address, warehouse_location,
                                    warehouse_country, warehouse_zipcode, warehouse_state,
                                    warehouse_city, organisation_id)
             VALUES ('Depot', '1 Test Way',
                     extensions.st_setsrid(extensions.st_makepoint(5, 5), 4326),
                     'SG', '000000', 'SG', 'Singapore', $1)
             RETURNING id`,
            [organisationId],
        );

        return { organisationId, warehouseId: warehouses[0].id, ownerId };
    }

    async function createDriver(tenant: Tenant): Promise<string> {
        const id = await createUser();
        await client.query(
            `INSERT INTO drivers (id, organisation_id, warehouse_id) VALUES ($1, $2, $3)`,
            [id, tenant.organisationId, tenant.warehouseId],
        );
        return id;
    }

    async function createArea(
        tenant: Tenant,
        name: string,
        ewkt: string,
        opts: { isDeleted?: boolean } = {},
    ): Promise<string> {
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO service_areas (name, geometry, organisation_id, is_deleted)
             VALUES ($1, extensions.st_geomfromtext($2, 4326), $3, $4)
             RETURNING id`,
            [name, ewkt, tenant.organisationId, opts.isDeleted ?? false],
        );
        return rows[0].id;
    }

    async function cover(
        tenant: Tenant,
        driverId: string,
        serviceAreaId: string,
    ): Promise<void> {
        await client.query(
            `INSERT INTO driver_service_area (driver_id, service_area_id, organisation_id)
             VALUES ($1, $2, $3)`,
            [driverId, serviceAreaId, tenant.organisationId],
        );
    }

    /** Makes auth.uid() answer `userId` for the rest of the transaction. */
    async function actAs(userId: string): Promise<void> {
        await client.query(
            `SELECT set_config('request.jwt.claims', $1, true)`,
            [JSON.stringify({ sub: userId, role: 'authenticated' })],
        );
    }

    function coverageFor(tenant: Tenant) {
        return {
            organisationId: tenant.organisationId,
            warehouseId: tenant.warehouseId,
        };
    }

    // ── Coverage geometry ────────────────────────────────────────────────────

    describe('one point', () => {
        it('returns the driver whose single area contains it', async () => {
            const tenant = await createTenant();
            const driver = await createDriver(tenant);
            await cover(tenant, driver, await createArea(tenant, 'West', WEST));

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                INSIDE_WEST,
            );

            expect(coverage.explicitDriverIds).toEqual([driver]);
            expect(coverage.floaterDriverIds).toEqual([]);
            expect(coverage.driverIds).toEqual([driver]);
        });

        it('returns BOTH drivers when two overlapping areas contain it', async () => {
            // Overlap is a legitimate configuration. Two drivers sharing a dense
            // centre while each also owns a suburb is how a metro gets drawn,
            // and nothing in the schema forbids it.
            const tenant = await createTenant();
            const westDriver = await createDriver(tenant);
            const straddleDriver = await createDriver(tenant);
            await cover(
                tenant,
                westDriver,
                await createArea(tenant, 'West', WEST),
            );
            await cover(
                tenant,
                straddleDriver,
                await createArea(tenant, 'Straddle', STRADDLE),
            );

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                INSIDE_BOTH,
            );

            expect(coverage.driverIds.sort()).toEqual(
                [westDriver, straddleDriver].sort(),
            );
        });

        it('covers a point exactly on a shared boundary, from both sides', async () => {
            // A dispatcher draws the seam between two territories down the
            // middle of a street, and addresses sit on streets. ST_Contains is
            // false for a boundary point and would leave this address covered by
            // nobody; ST_Covers is true and it belongs to both.
            const tenant = await createTenant();
            const westDriver = await createDriver(tenant);
            const eastDriver = await createDriver(tenant);
            await cover(
                tenant,
                westDriver,
                await createArea(tenant, 'West', WEST),
            );
            await cover(
                tenant,
                eastDriver,
                await createArea(tenant, 'East', EAST),
            );

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                ON_SEAM,
            );

            expect(coverage.driverIds.sort()).toEqual(
                [westDriver, eastDriver].sort(),
            );
        });

        it('returns nobody for a point outside every area', async () => {
            const tenant = await createTenant();
            const driver = await createDriver(tenant);
            await cover(tenant, driver, await createArea(tenant, 'West', WEST));

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                OUTSIDE_EVERYTHING,
            );

            expect(coverage.driverIds).toEqual([]);
        });

        it('excludes a soft-deleted area, which RLS does not filter', async () => {
            const tenant = await createTenant();
            const driver = await createDriver(tenant);
            await cover(
                tenant,
                driver,
                await createArea(tenant, 'Retired West', WEST, {
                    isDeleted: true,
                }),
            );

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                INSIDE_WEST,
            );

            expect(coverage.explicitDriverIds).toEqual([]);
            // And crucially NOT promoted to a floater: they have a coverage row,
            // it is just pointing at a territory that was retired. Silently
            // giving them the whole metro because a dispatcher retired one
            // polygon would be a surprising reading of that click.
            expect(coverage.floaterDriverIds).toEqual([]);
            expect(coverage.driverIds).toEqual([]);
        });

        it('ignores a driver at another warehouse in the same organisation', async () => {
            const tenant = await createTenant();
            const otherWarehouse = await createTenant();
            const driver = await createDriver(tenant);
            const area = await createArea(tenant, 'West', WEST);
            await cover(tenant, driver, area);

            const coverage = await coveringDriversForPoint(
                executor,
                {
                    organisationId: tenant.organisationId,
                    warehouseId: otherWarehouse.warehouseId,
                },
                INSIDE_WEST,
            );

            expect(coverage.driverIds).toEqual([]);
        });

        it('ignores another organisation entirely', async () => {
            const us = await createTenant();
            const them = await createTenant();
            const theirDriver = await createDriver(them);
            await cover(
                them,
                theirDriver,
                await createArea(them, 'West', WEST),
            );

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(us),
                INSIDE_WEST,
            );

            expect(coverage.driverIds).toEqual([]);
        });
    });

    // ── The floater rule ─────────────────────────────────────────────────────

    describe('the floater rule', () => {
        it('gives a driver with no areas at all every point', async () => {
            const tenant = await createTenant();
            const floater = await createDriver(tenant);

            for (const point of [INSIDE_WEST, ON_SEAM, OUTSIDE_EVERYTHING]) {
                const coverage = await coveringDriversForPoint(
                    executor,
                    coverageFor(tenant),
                    point,
                );
                expect(coverage.floaterDriverIds).toEqual([floater]);
                expect(coverage.driverIds).toEqual([floater]);
            }
        });

        it('makes an empty driver_service_area behave exactly like no feature at all', async () => {
            // The requirement the rule exists for: on the morning this ships,
            // nobody has any coverage rows, and every driver must stay eligible
            // for everything.
            const tenant = await createTenant();
            const a = await createDriver(tenant);
            const b = await createDriver(tenant);

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                OUTSIDE_EVERYTHING,
            );

            expect(coverage.driverIds.sort()).toEqual([a, b].sort());
        });

        it('reports floaters and explicit coverage separately', async () => {
            const tenant = await createTenant();
            const floater = await createDriver(tenant);
            const staffed = await createDriver(tenant);
            await cover(
                tenant,
                staffed,
                await createArea(tenant, 'West', WEST),
            );

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                INSIDE_WEST,
            );

            expect(coverage.floaterDriverIds).toEqual([floater]);
            expect(coverage.explicitDriverIds).toEqual([staffed]);
            expect(coverage.driverIds.sort()).toEqual(
                [floater, staffed].sort(),
            );
        });

        it('stops treating a driver as a floater the moment they get one area', async () => {
            const tenant = await createTenant();
            const driver = await createDriver(tenant);
            await cover(tenant, driver, await createArea(tenant, 'West', WEST));

            const coverage = await coveringDriversForPoint(
                executor,
                coverageFor(tenant),
                OUTSIDE_EVERYTHING,
            );

            expect(coverage.driverIds).toEqual([]);
        });
    });

    // ── The batch form ───────────────────────────────────────────────────────

    describe('the batch form', () => {
        it('resolves 500 points in one round trip', async () => {
            const tenant = await createTenant();
            const westDriver = await createDriver(tenant);
            const floater = await createDriver(tenant);
            await cover(
                tenant,
                westDriver,
                await createArea(tenant, 'West', WEST),
            );

            // 250 inside WEST, 250 well outside it, interleaved so an
            // off-by-one in the ordinality mapping cannot pass by accident.
            const points = Array.from({ length: 500 }, (_, i) =>
                i % 2 === 0
                    ? { lon: 1 + (i / 500) * 8, lat: 5 }
                    : { lon: 100 + (i / 500) * 8, lat: 40 },
            );

            roundTrips = 0;
            const coverage = await coveringDriversForPoints(
                executor,
                coverageFor(tenant),
                points,
            );

            expect(roundTrips).toBe(1);
            expect(coverage).toHaveLength(500);
            for (let i = 0; i < 500; i++) {
                expect(coverage[i].pointIndex).toBe(i);
                expect(coverage[i].driverIds.sort()).toEqual(
                    i % 2 === 0 ? [westDriver, floater].sort() : [floater],
                );
            }
        });

        it('agrees with the single-point form point for point', async () => {
            // The guarantee the whole module is built around: the assignment
            // path and the diagnostic endpoint must never be able to disagree.
            const tenant = await createTenant();
            const westDriver = await createDriver(tenant);
            const eastDriver = await createDriver(tenant);
            await cover(
                tenant,
                westDriver,
                await createArea(tenant, 'West', WEST),
            );
            await cover(
                tenant,
                eastDriver,
                await createArea(tenant, 'East', EAST),
            );

            const points = [
                INSIDE_WEST,
                INSIDE_BOTH,
                ON_SEAM,
                OUTSIDE_EVERYTHING,
            ];
            const batch = await coveringDriversForPoints(
                executor,
                coverageFor(tenant),
                points,
            );

            for (let i = 0; i < points.length; i++) {
                const single = await coveringDriversForPoint(
                    executor,
                    coverageFor(tenant),
                    points[i],
                );
                expect(batch[i].driverIds).toEqual(single.driverIds);
                expect(batch[i].explicitDriverIds).toEqual(
                    single.explicitDriverIds,
                );
                expect(batch[i].floaterDriverIds).toEqual(
                    single.floaterDriverIds,
                );
            }
        });
    });

    // ── Cross-tenant writes ──────────────────────────────────────────────────

    describe('cross-tenant writes', () => {
        /**
         * Attempts an insert that must fail, inside a SAVEPOINT so the failure
         * does not abort the test's own transaction, and returns the SQLSTATE.
         */
        async function attemptInsert(
            driverId: string,
            serviceAreaId: string,
            organisationId: string,
        ): Promise<string> {
            await client.query('SAVEPOINT attempt');
            try {
                await client.query(
                    `INSERT INTO driver_service_area (driver_id, service_area_id, organisation_id)
                     VALUES ($1, $2, $3)`,
                    [driverId, serviceAreaId, organisationId],
                );
                await client.query('ROLLBACK TO SAVEPOINT attempt');
                return 'inserted';
            } catch (err: unknown) {
                await client.query('ROLLBACK TO SAVEPOINT attempt');
                return (err as { code?: string }).code ?? 'unknown';
            }
        }

        /**
         * Runs the rest of the test as a real `authenticated` session belonging
         * to `userId`, so RLS actually applies. Without the role switch the
         * connection is the schema owner and every policy is bypassed, which
         * would make these tests pass for the wrong reason.
         */
        async function asAuthenticated(userId: string): Promise<void> {
            await actAs(userId);
            await client.query('SET LOCAL ROLE authenticated');
        }

        it('accepts a same-organisation pairing from a permitted user', async () => {
            // The control. Without it, every rejection below could be explained
            // by the policy simply refusing everything.
            const tenant = await createTenant();
            const driver = await createDriver(tenant);
            const area = await createArea(tenant, 'West', WEST);

            await asAuthenticated(tenant.ownerId);
            const result = await attemptInsert(
                driver,
                area,
                tenant.organisationId,
            );
            await client.query('RESET ROLE');

            expect(result).toBe('inserted');
        });

        it("rejects another organisation's area, even from a fully permitted user", async () => {
            // The sharpest case. This writer has genuine service_areas.edit in
            // their own organisation and is naming their own organisation on the
            // row. Only the composite foreign key stops it.
            const us = await createTenant();
            const them = await createTenant();
            const ourDriver = await createDriver(us);
            const theirArea = await createArea(them, 'Their West', WEST);

            await asAuthenticated(us.ownerId);
            const result = await attemptInsert(
                ourDriver,
                theirArea,
                us.organisationId,
            );
            await client.query('RESET ROLE');

            // 23503 foreign_key_violation, from
            // driver_service_area_area_org_fkey.
            expect(result).toBe('23503');
        });

        it("rejects another organisation's driver, even from a fully permitted user", async () => {
            const us = await createTenant();
            const them = await createTenant();
            const theirDriver = await createDriver(them);
            const ourArea = await createArea(us, 'West', WEST);

            await asAuthenticated(us.ownerId);
            const result = await attemptInsert(
                theirDriver,
                ourArea,
                us.organisationId,
            );
            await client.query('RESET ROLE');

            expect(result).toBe('23503');
        });

        it("rejects relabelling another organisation's pairing as one's own", async () => {
            // The attack the organisation_id column would otherwise open, and
            // the one a same_org(driver, area) function would NOT catch: both
            // parents genuinely are in the same organisation as each other, just
            // not in the one the row claims.
            const us = await createTenant();
            const them = await createTenant();
            const theirDriver = await createDriver(them);
            const theirArea = await createArea(them, 'Their West', WEST);

            await asAuthenticated(us.ownerId);
            const result = await attemptInsert(
                theirDriver,
                theirArea,
                us.organisationId,
            );
            await client.query('RESET ROLE');

            expect(result).toBe('23503');
        });

        it('rejects a truthful pairing in an organisation the writer has no rights in', async () => {
            // Here the foreign keys are all satisfied, so this one is RLS's job:
            // 42501 insufficient_privilege from the WITH CHECK.
            const us = await createTenant();
            const them = await createTenant();
            const theirDriver = await createDriver(them);
            const theirArea = await createArea(them, 'Their West', WEST);

            await asAuthenticated(us.ownerId);
            const result = await attemptInsert(
                theirDriver,
                theirArea,
                them.organisationId,
            );
            await client.query('RESET ROLE');

            expect(result).toBe('42501');
        });

        it('rejects a cross-tenant pairing even for a role that bypasses RLS', async () => {
            // The whole reason this table uses composite foreign keys rather
            // than a same_org() call inside the RLS policy. No role switch here:
            // this runs as the schema owner, for which every policy on this
            // table is inert, exactly as it would be for service_role. The
            // rejection therefore cannot be coming from RLS.
            const us = await createTenant();
            const them = await createTenant();
            const theirDriver = await createDriver(them);
            const ourArea = await createArea(us, 'West', WEST);

            // organisation_id is truthful for the driver, so the driver-side key
            // is satisfied; the area-side key is what rejects it.
            const result = await attemptInsert(
                theirDriver,
                ourArea,
                them.organisationId,
            );

            expect(result).toBe('23503');
        });
    });
});
