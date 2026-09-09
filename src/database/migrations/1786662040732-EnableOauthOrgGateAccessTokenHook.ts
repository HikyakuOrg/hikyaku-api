import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class EnableOauthOrgGateAccessTokenHook1786662040732 implements MigrationInterface {
    name = 'EnableOauthOrgGateAccessTokenHook1786662040732';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1786662040732-enable_oauth_org_gate_access_token_hook.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."gate_oauth_token_to_company_org"("event" "jsonb");
        `);
    }
}
