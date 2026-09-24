import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';

export class ScopeListRpcsToOrganisation1789606800000 implements MigrationInterface {
    name = 'ScopeListRpcsToOrganisation1789606800000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1789606800000-scope_list_rpcs_to_organisation.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drops the p_organisation_id signatures and restores the previous
        // ones verbatim, rather than leaving callers with no function at all.
        await queryRunner.query(
            this.read('1789606800000-scope_list_rpcs_to_organisation.down.sql'),
        );
    }
}
