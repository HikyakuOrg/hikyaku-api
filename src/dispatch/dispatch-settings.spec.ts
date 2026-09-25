import { readFileSync } from 'fs';
import { join } from 'path';
import {
    DEFAULT_DISPATCH_SETTINGS,
    DISPATCH_SETTINGS_SQL,
    resolveDispatchSettings,
    type AssignmentMode,
    type DispatchSettingsQueryExecutor,
} from './dispatch-settings';

const ORG = '11111111-1111-4111-8111-111111111111';

/** Answers the settings query with `rows` and records what it was asked. */
function fakeExecutor(rows: Record<string, unknown>[]) {
    const calls: { sql: string; parameters: unknown[] | undefined }[] = [];
    const executor: DispatchSettingsQueryExecutor = {
        query(sql: string, parameters?: unknown[]): Promise<unknown> {
            calls.push({ sql, parameters });
            return Promise.resolve(rows);
        },
    };
    return { executor, calls };
}

describe('resolveDispatchSettings', () => {
    it('gives an organisation that never saved its settings the defaults', async () => {
        const { executor } = fakeExecutor([]);

        const settings = await resolveDispatchSettings(executor, ORG);

        expect(settings).toEqual({
            assignmentMode: 'instant',
            loadSpread: true,
            serviceAreaMatching: false,
        });
    });

    it('hands back a copy, so a caller cannot change the defaults for everyone', async () => {
        const { executor } = fakeExecutor([]);
        const settings = await resolveDispatchSettings(executor, ORG);
        expect(settings).not.toBe(DEFAULT_DISPATCH_SETTINGS);
    });

    it("reads the organisation's own row", async () => {
        const { executor } = fakeExecutor([
            {
                assignment_mode: 'manual',
                load_spread_enabled: false,
                service_area_matching: true,
            },
        ]);

        const settings = await resolveDispatchSettings(executor, ORG);

        expect(settings).toEqual({
            assignmentMode: 'manual',
            loadSpread: false,
            serviceAreaMatching: true,
        });
    });

    it('asks about exactly one organisation', async () => {
        // service_role bypasses RLS, so this predicate is the tenancy.
        const { executor, calls } = fakeExecutor([]);

        await resolveDispatchSettings(executor, ORG);

        expect(calls).toEqual([
            { sql: DISPATCH_SETTINGS_SQL, parameters: [ORG] },
        ]);
        expect(DISPATCH_SETTINGS_SQL).toContain('WHERE organisation_id = $1');
    });

    it('reads an assignment mode it does not recognise as instant, not as off', async () => {
        const { executor } = fakeExecutor([
            {
                assignment_mode: 'nightly',
                load_spread_enabled: true,
                service_area_matching: false,
            },
        ]);

        const settings = await resolveDispatchSettings(executor, ORG);

        expect(settings.assignmentMode).toBe('instant');
    });

    it('lets a failed query through for the caller to decide about', async () => {
        const executor: DispatchSettingsQueryExecutor = {
            query: () => Promise.reject(new Error('connection reset')),
        };

        await expect(resolveDispatchSettings(executor, ORG)).rejects.toThrow(
            'connection reset',
        );
    });
});

describe('the defaults, against the migration that created the table', () => {
    // An organisation without a row runs on DEFAULT_DISPATCH_SETTINGS, and a
    // row written without a value takes the column's DEFAULT. If the two ever
    // disagreed, saving the settings page once would quietly change how an
    // organisation is dispatched.
    const sql = readFileSync(
        join(
            __dirname,
            '../database/migrations/1789693200000-create_organisation_dispatch_settings.sql',
        ),
        'utf8',
    );

    function columnDefault(column: string): string | undefined {
        return new RegExp(`"${column}"\\s+\\w+\\s+NOT NULL DEFAULT ([^,\\n]+),`)
            .exec(sql)?.[1]
            .trim();
    }

    it('agree on the assignment mode', () => {
        expect(columnDefault('assignment_mode')).toBe(
            `'${DEFAULT_DISPATCH_SETTINGS.assignmentMode}'`,
        );
    });

    it('agree on load spreading', () => {
        expect(columnDefault('load_spread_enabled')).toBe(
            String(DEFAULT_DISPATCH_SETTINGS.loadSpread),
        );
    });

    it('agree on service area matching', () => {
        expect(columnDefault('service_area_matching')).toBe(
            String(DEFAULT_DISPATCH_SETTINGS.serviceAreaMatching),
        );
    });

    it('allow exactly the assignment modes the type does', () => {
        // A Record over the union, so adding a mode to the type without adding
        // it here is a compile error rather than a passing test.
        const modes: Record<AssignmentMode, true> = {
            instant: true,
            manual: true,
        };
        const check = /"assignment_mode" IN \(([^)]*)\)/.exec(sql)?.[1];

        expect(
            check?.split(',').map((value) => value.trim().replace(/'/g, '')),
        ).toEqual(Object.keys(modes));
    });
});
