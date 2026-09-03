import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class RestrictOrganisationLogoToCompanyOrgs1787101200000
    implements MigrationInterface
{
    name = 'RestrictOrganisationLogoToCompanyOrgs1787101200000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read(
                '1787101200000-restrict_organisation_logo_to_company_orgs.sql',
            ),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse creation order: the trigger goes before the function it
        // calls, same as AddOrganisationVanitySlug's down().
        await queryRunner.query(`
            DROP TRIGGER IF EXISTS "organisations_company_logo_only" ON "public"."organisations";
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."enforce_company_org_logo"();
        `);

        // Restore AddOrganisationLogo's wording. Reverting drops the rule, so
        // the comment has to stop claiming it -- a column comment that
        // describes an enforcement that is no longer there is worse than none.
        await queryRunner.query(`
            COMMENT ON COLUMN "public"."organisations"."logo_url" IS
                'Public Supabase Storage URL of the org''s uploaded logo (org-logos '
                'bucket, path <organisation_id>/logo.<ext>). NULL when no logo has been '
                'uploaded. Settable by any team member, same as name/org_type.';
        `);

        // Restore the org-logos write policies to AddOrgLogosStorageBucket's
        // versions -- team membership only, no org_type condition -- before
        // dropping the function they call, or the policies are left referencing
        // a function that no longer exists and every logo upload starts failing.
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_team_insert" ON "storage"."objects";
        `);
        await queryRunner.query(`
            CREATE POLICY "org_logos_team_insert"
                ON "storage"."objects" FOR INSERT
                TO "authenticated"
                WITH CHECK (
                    bucket_id = 'org-logos'
                    AND EXISTS (
                        SELECT 1 FROM "public"."team_members" tm
                         WHERE tm."id" = auth.uid()
                           AND tm."organisation_id"::text = (storage.foldername("name"))[1]
                    )
                );
        `);
        await queryRunner.query(`
            DROP POLICY IF EXISTS "org_logos_team_update" ON "storage"."objects";
        `);
        await queryRunner.query(`
            CREATE POLICY "org_logos_team_update"
                ON "storage"."objects" FOR UPDATE
                TO "authenticated"
                USING (
                    bucket_id = 'org-logos'
                    AND EXISTS (
                        SELECT 1 FROM "public"."team_members" tm
                         WHERE tm."id" = auth.uid()
                           AND tm."organisation_id"::text = (storage.foldername("name"))[1]
                    )
                )
                WITH CHECK (
                    bucket_id = 'org-logos'
                    AND EXISTS (
                        SELECT 1 FROM "public"."team_members" tm
                         WHERE tm."id" = auth.uid()
                           AND tm."organisation_id"::text = (storage.foldername("name"))[1]
                    )
                );
        `);
        await queryRunner.query(`
            DROP FUNCTION IF EXISTS "public"."is_company_organisation"(text);
        `);

        // The column-level grant is left as-is: up() only restated what
        // AddOrganisationLogo already granted, so there is nothing here to undo
        // -- and revoking logo_url would break company-org branding, which this
        // migration never touched. org_logos_team_delete/_read are likewise
        // untouched, because up() never changed them.
    }
}
