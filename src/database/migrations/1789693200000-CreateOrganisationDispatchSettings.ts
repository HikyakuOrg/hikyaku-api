import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * What this deployment's environment says, parsed exactly as AssignmentService
 * parsed it before this migration: anything but `nightly` meant instant
 * assignment, anything but `false` or `0` meant load spreading on, and only
 * `on`, `true` or `1` meant service area matching on.
 *
 * Frozen here rather than imported from src/dispatch, so this migration keeps
 * doing what it did on the day it ran however that code changes afterwards.
 */
function settingsFromEnv(env: NodeJS.ProcessEnv): {
    assignmentMode: 'instant' | 'manual';
    loadSpreadEnabled: boolean;
    serviceAreaMatching: boolean;
} {
    const spread = env.LOAD_SPREAD_ENABLED;
    const matching = env.SERVICE_AREA_MATCHING;
    return {
        assignmentMode:
            env.ASSIGNMENT_MODE === 'nightly' ? 'manual' : 'instant',
        loadSpreadEnabled: spread !== 'false' && spread !== '0',
        serviceAreaMatching:
            matching === 'on' || matching === 'true' || matching === '1',
    };
}

export class CreateOrganisationDispatchSettings1789693200000 implements MigrationInterface {
    name = 'CreateOrganisationDispatchSettings1789693200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1789693200000-create_organisation_dispatch_settings.sql',
            ),
        );

        // The env vars stop being read the moment this ships, so a deployment
        // running any of them at a non-default value would otherwise change
        // every tenant's routing on deploy. Their answer was process-wide, so
        // it is carried to every organisation that exists now, which is
        // exactly who it applied to; each can change it from Settings >
        // Dispatch afterwards. With every value at its default there is
        // nothing to carry: no row already means the defaults.
        //
        // start:prod runs this inside the API container, whose environment
        // is the deployment's. Run by hand from a checkout whose .env does not
        // set these, it carries nothing, and those organisations fall back to
        // the defaults.
        const carried = settingsFromEnv(process.env);
        if (
            carried.assignmentMode === 'instant' &&
            carried.loadSpreadEnabled &&
            !carried.serviceAreaMatching
        ) {
            return;
        }

        await queryRunner.query(
            `INSERT INTO "public"."organisation_dispatch_settings"
                 ("organisation_id", "assignment_mode", "load_spread_enabled", "service_area_matching")
             SELECT "id", $1::text, $2::boolean, $3::boolean
               FROM "public"."organisations"
             ON CONFLICT ("organisation_id") DO NOTHING`,
            [
                carried.assignmentMode,
                carried.loadSpreadEnabled,
                carried.serviceAreaMatching,
            ],
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Whatever organisations saved is lost with the table. The code this
        // reverts to reads the env vars again, so set those first if any
        // organisation needs a non-default answer back.
        await queryRunner.query(`
            COMMENT ON COLUMN "public"."package_assignment"."coverage_outcome" IS
                'How the driver that got this package related to who covers its delivery point, recorded at placement time because none of the inputs to that decision are versioned. NULL means the row was not written by automatic assignment (a replan or a dispatcher''s hand edit), so \`WHERE coverage_outcome IS NOT NULL\` is the automatically-assigned population. \`covered\`: a territory the driver is staffed on contains the point. \`floater\`: the driver matched only because they have no territories at all, which is most matches while the map is half drawn and is why it is not merged into \`covered\`. \`fallback_no_covering_capacity\`: somebody covers the point but none of them had room or an idle van. \`fallback_no_covering_driver\`: nobody covers it at all. \`disabled\`: SERVICE_AREA_MATCHING was off and no coverage question was asked. See src/dispatch/coverage.ts.';
        `);

        // The table takes its policies and trigger with it.
        await queryRunner.query(
            `DROP TABLE IF EXISTS "public"."organisation_dispatch_settings"`,
        );
        await queryRunner.query(
            `DROP FUNCTION IF EXISTS "public"."organisation_dispatch_settings_touch"()`,
        );
    }
}
