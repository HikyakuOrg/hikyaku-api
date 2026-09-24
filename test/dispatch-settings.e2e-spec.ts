import { Client } from 'pg';
import {
    DEFAULT_DISPATCH_SETTINGS,
    resolveDispatchSettings,
    type DispatchSettingsQueryExecutor,
} from '../src/dispatch/dispatch-settings';

/**
 * organisation_dispatch_settings against a real database: the RLS the web
 * dashboard writes through, the touch trigger, and the defaults an
 * organisation without a row runs on.
 *
 * Everything decidable without a database is in
 * src/dispatch/dispatch-settings.spec.ts. This file needs live policies,
 * grants and triggers, so it runs only under `pnpm test:e2e`, against
 * DB_MIGRATION_URL (preferred) or DB_URL with this repo's migrations applied,
 * connecting as a role that owns the public schema. Without either it skips.
 *
 * EVERY TEST RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK, fixtures
 * included, for the reason test/coverage.e2e-spec.ts gives: the DB_URL in a
 * working checkout points at a real Supabase project. Statements that must
 * fail run inside a SAVEPOINT so the failure does not abort the test.
 */

const DB_URL = process.env.DB_MIGRATION_URL ?? process.env.DB_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

/** The surface of `pg.Client` this file uses; see coverage.e2e-spec.ts. */
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

/**
 * The statement PostgREST sends for the dashboard's
 * `.upsert(..., { onConflict: 'organisation_id' })`: every column in the
 * payload is re-set on conflict, organisation_id included, which is why
 * authenticated needs UPDATE on that column and the trigger is what keeps it
 * fixed.
 */
const UPSERT_SQL = `INSERT INTO organisation_dispatch_settings
        (organisation_id, assignment_mode, load_spread_enabled, service_area_matching)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organisation_id) DO UPDATE SET
        organisation_id       = EXCLUDED.organisation_id,
        assignment_mode       = EXCLUDED.assignment_mode,
        load_spread_enabled   = EXCLUDED.load_spread_enabled,
        service_area_matching = EXCLUDED.service_area_matching
     RETURNING organisation_id, updated_by`;

interface SettingsRow {
    organisation_id: string;
    assignment_mode: string;
    load_spread_enabled: boolean;
    service_area_matching: boolean;
    created_at: Date;
    updated_at: Date;
    updated_by: string | null;
}

describeWithDb('organisation_dispatch_settings against a real database', () => {
    jest.setTimeout(60_000);

    let client: PgClient;
    let executor: DispatchSettingsQueryExecutor;

    beforeAll(async () => {
        client = new PgClientCtor({ connectionString: DB_URL! });
        await client.connect();
        executor = {
            async query(sql: string, parameters?: unknown[]): Promise<unknown> {
                return (await client.query(sql, parameters)).rows;
            },
        };
    });

    afterAll(async () => {
        await client.end();
    });

    beforeEach(async () => {
        await client.query('BEGIN');
    });

    afterEach(async () => {
        await client.query('ROLLBACK');
    });

    // ── Fixtures ─────────────────────────────────────────────────────────────

    async function createUser(): Promise<string> {
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO auth.users (id, email)
             VALUES (gen_random_uuid(), gen_random_uuid()::text || '@dispatch-settings.test')
             RETURNING id`,
        );
        return rows[0].id;
    }

    /** Makes auth.uid() answer `userId` for the rest of the transaction. */
    async function actAs(userId: string): Promise<void> {
        await client.query(
            `SELECT set_config('request.jwt.claims', $1, true)`,
            [JSON.stringify({ sub: userId, role: 'authenticated' })],
        );
    }

    /**
     * An organisation and the user who created it. handle_new_organisation()
     * grants the creator every seeded permission, organisation.edit included,
     * and raises when auth.uid() is null, hence the claim first.
     */
    async function createOrganisation(
        ownerId?: string,
    ): Promise<{ organisationId: string; ownerId: string }> {
        const owner = ownerId ?? (await createUser());
        await actAs(owner);
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO organisations (name, org_type, created_by)
             VALUES ('dispatch-settings-' || gen_random_uuid()::text, 'company', $1)
             RETURNING id`,
            [owner],
        );
        return { organisationId: rows[0].id, ownerId: owner };
    }

    /**
     * A member of the organisation holding no permission at all, through a
     * role minted here with none attached, so the test does not depend on
     * what the seeded roles happen to grant. The id is picked explicitly
     * because app_roles was seeded with explicit ids and its identity
     * sequence was never advanced past them.
     */
    async function createPlainMember(organisationId: string): Promise<string> {
        const userId = await createUser();
        const { rows } = await client.query<{ id: string }>(
            `INSERT INTO app_roles (id, name)
             SELECT MAX(id) + 1, 'dispatch-settings-test-role' FROM app_roles
             RETURNING id`,
        );
        await client.query(
            `INSERT INTO team_members (id, role_id, organisation_id) VALUES ($1, $2, $3)`,
            [userId, rows[0].id, organisationId],
        );
        return userId;
    }

    /**
     * Runs what follows as a real `authenticated` session for `userId`, so RLS
     * applies. Without the role switch this connection owns the table and
     * every policy is bypassed.
     */
    async function asAuthenticated(userId: string): Promise<void> {
        await actAs(userId);
        await client.query('SET LOCAL ROLE authenticated');
    }

    /** Runs `sql` in a SAVEPOINT; returns its rows, or the SQLSTATE it failed with. */
    async function attempt<R>(
        sql: string,
        values: unknown[] = [],
    ): Promise<{ rows: R[] } | { code: string }> {
        await client.query('SAVEPOINT attempt');
        try {
            const result = await client.query<R>(sql, values);
            await client.query('RELEASE SAVEPOINT attempt');
            return { rows: result.rows };
        } catch (err: unknown) {
            await client.query('ROLLBACK TO SAVEPOINT attempt');
            return { code: (err as { code?: string }).code ?? 'unknown' };
        }
    }

    async function readRow(
        organisationId: string,
    ): Promise<SettingsRow | undefined> {
        const { rows } = await client.query<SettingsRow>(
            `SELECT * FROM organisation_dispatch_settings WHERE organisation_id = $1`,
            [organisationId],
        );
        return rows[0];
    }

    // ── Defaults ─────────────────────────────────────────────────────────────

    describe('the defaults', () => {
        it('are what an organisation that never saved its settings runs on', async () => {
            const { organisationId } = await createOrganisation();

            expect(await readRow(organisationId)).toBeUndefined();
            expect(
                await resolveDispatchSettings(executor, organisationId),
            ).toEqual(DEFAULT_DISPATCH_SETTINGS);
        });

        it('are also what a row written with no values holds', async () => {
            // So saving the page once with nothing changed cannot change how
            // an organisation is dispatched.
            const { organisationId } = await createOrganisation();
            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id) VALUES ($1)`,
                [organisationId],
            );

            expect(
                await resolveDispatchSettings(executor, organisationId),
            ).toEqual(DEFAULT_DISPATCH_SETTINGS);
        });
    });

    // ── The dashboard's write path ───────────────────────────────────────────

    describe('an organisation admin', () => {
        it('saves through the upsert the dashboard sends, first insert then update', async () => {
            const { organisationId, ownerId } = await createOrganisation();

            await asAuthenticated(ownerId);
            const inserted = await attempt<{ updated_by: string }>(UPSERT_SQL, [
                organisationId,
                'manual',
                false,
                true,
            ]);
            const updated = await attempt<{ updated_by: string }>(UPSERT_SQL, [
                organisationId,
                'instant',
                false,
                true,
            ]);
            await client.query('RESET ROLE');

            expect(inserted).toEqual({
                rows: [
                    { organisation_id: organisationId, updated_by: ownerId },
                ],
            });
            expect(updated).toEqual({
                rows: [
                    { organisation_id: organisationId, updated_by: ownerId },
                ],
            });
            expect(
                await resolveDispatchSettings(executor, organisationId),
            ).toEqual({
                assignmentMode: 'instant',
                loadSpread: false,
                serviceAreaMatching: true,
            });
        });

        it("cannot write another organisation's settings", async () => {
            const us = await createOrganisation();
            const them = await createOrganisation();

            await asAuthenticated(us.ownerId);
            const result = await attempt(UPSERT_SQL, [
                them.organisationId,
                'manual',
                true,
                false,
            ]);
            await client.query('RESET ROLE');

            expect(result).toEqual({ code: '42501' });
            expect(await readRow(them.organisationId)).toBeUndefined();
        });

        it('cannot move a row onto another organisation it also administers', async () => {
            // The update policy checks the row as it ends up, which this
            // writer passes for both organisations. Only the trigger stops it.
            const first = await createOrganisation();
            const second = await createOrganisation(first.ownerId);
            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id, assignment_mode)
                 VALUES ($1, 'manual')`,
                [first.organisationId],
            );

            await asAuthenticated(first.ownerId);
            const result = await attempt(
                `UPDATE organisation_dispatch_settings SET organisation_id = $2
                  WHERE organisation_id = $1 RETURNING organisation_id`,
                [first.organisationId, second.organisationId],
            );
            await client.query('RESET ROLE');

            // P0001 raise_exception, from organisation_dispatch_settings_touch.
            expect(result).toEqual({ code: 'P0001' });
            expect((await readRow(first.organisationId))?.assignment_mode).toBe(
                'manual',
            );
        });

        it('cannot delete the row, since going back to the defaults is a save', async () => {
            const { organisationId, ownerId } = await createOrganisation();
            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id) VALUES ($1)`,
                [organisationId],
            );

            await asAuthenticated(ownerId);
            const result = await attempt(
                `DELETE FROM organisation_dispatch_settings WHERE organisation_id = $1`,
                [organisationId],
            );
            await client.query('RESET ROLE');

            expect(result).toEqual({ code: '42501' });
        });

        it('cannot rewrite created_at, which the trigger keeps', async () => {
            const { organisationId, ownerId } = await createOrganisation();
            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id) VALUES ($1)`,
                [organisationId],
            );
            const before = await readRow(organisationId);

            await asAuthenticated(ownerId);
            await attempt(
                `UPDATE organisation_dispatch_settings
                    SET created_at = '2000-01-01', load_spread_enabled = false
                  WHERE organisation_id = $1`,
                [organisationId],
            );
            await client.query('RESET ROLE');

            const after = await readRow(organisationId);
            expect(after?.created_at).toEqual(before?.created_at);
            expect(after?.load_spread_enabled).toBe(false);
        });
    });

    describe('a member without organisation.edit', () => {
        it('can read the settings but not change them', async () => {
            const { organisationId } = await createOrganisation();
            const member = await createPlainMember(organisationId);
            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id, assignment_mode)
                 VALUES ($1, 'manual')`,
                [organisationId],
            );

            await asAuthenticated(member);
            const permitted = await attempt<{ allowed: boolean }>(
                `SELECT has_org_permission($1, 'organisation.edit') AS allowed`,
                [organisationId],
            );
            const read = await attempt<{ assignment_mode: string }>(
                `SELECT assignment_mode FROM organisation_dispatch_settings
                  WHERE organisation_id = $1`,
                [organisationId],
            );
            // An UPDATE the USING clause filters out is not an error, it
            // matches nothing, which is what PostgREST reports as PGRST116.
            const update = await attempt(
                `UPDATE organisation_dispatch_settings SET assignment_mode = 'instant'
                  WHERE organisation_id = $1 RETURNING organisation_id`,
                [organisationId],
            );
            await client.query('RESET ROLE');

            // The precondition, so a passing test cannot be explained by the
            // member having the permission after all.
            expect(permitted).toEqual({ rows: [{ allowed: false }] });
            expect(read).toEqual({ rows: [{ assignment_mode: 'manual' }] });
            expect(update).toEqual({ rows: [] });
            expect((await readRow(organisationId))?.assignment_mode).toBe(
                'manual',
            );
        });

        it('cannot create the row either', async () => {
            const { organisationId } = await createOrganisation();
            const member = await createPlainMember(organisationId);

            await asAuthenticated(member);
            const result = await attempt(UPSERT_SQL, [
                organisationId,
                'manual',
                true,
                false,
            ]);
            await client.query('RESET ROLE');

            expect(result).toEqual({ code: '42501' });
        });
    });

    describe('everybody else', () => {
        it('sees nothing of an organisation they are not a member of', async () => {
            const us = await createOrganisation();
            const them = await createOrganisation();
            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id) VALUES ($1)`,
                [them.organisationId],
            );

            await asAuthenticated(us.ownerId);
            const read = await attempt(
                `SELECT organisation_id FROM organisation_dispatch_settings
                  WHERE organisation_id = $1`,
                [them.organisationId],
            );
            await client.query('RESET ROLE');

            expect(read).toEqual({ rows: [] });
        });

        it('gets nothing at all as anon', async () => {
            await client.query('SET LOCAL ROLE anon');
            const read = await attempt(
                `SELECT organisation_id FROM organisation_dispatch_settings LIMIT 1`,
            );
            await client.query('RESET ROLE');

            expect(read).toEqual({ code: '42501' });
        });
    });

    describe('the constraints', () => {
        it('rejects an assignment mode the engine does not know', async () => {
            // `nightly` especially: it is the old env value, and the CHECK is
            // what stops it being written back in by hand.
            const { organisationId } = await createOrganisation();

            const result = await attempt(
                `INSERT INTO organisation_dispatch_settings (organisation_id, assignment_mode)
                 VALUES ($1, 'nightly')`,
                [organisationId],
            );

            // 23514 check_violation.
            expect(result).toEqual({ code: '23514' });
        });

        it('stamps updated_by as null for a write that is not a dashboard user', async () => {
            const { organisationId } = await createOrganisation();
            await client.query(
                `SELECT set_config('request.jwt.claims', '', true)`,
            );

            await client.query(
                `INSERT INTO organisation_dispatch_settings (organisation_id) VALUES ($1)`,
                [organisationId],
            );

            expect((await readRow(organisationId))?.updated_by).toBeNull();
        });
    });
});
