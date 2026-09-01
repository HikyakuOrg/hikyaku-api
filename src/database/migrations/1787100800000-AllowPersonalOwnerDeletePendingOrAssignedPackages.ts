import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AllowPersonalOwnerDeletePendingOrAssignedPackages1787100800000
    implements MigrationInterface
{
    name = 'AllowPersonalOwnerDeletePendingOrAssignedPackages1787100800000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1787100800000-allow_personal_owner_delete_pending_or_assigned_packages.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP POLICY IF EXISTS "packages delete personal owner" ON "public"."packages";
        `);
    }
}
