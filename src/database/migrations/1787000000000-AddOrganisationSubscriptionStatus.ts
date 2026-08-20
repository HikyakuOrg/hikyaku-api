import { MigrationInterface, QueryRunner } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';


export class AddOrganisationSubscriptionStatus1787000000000
    implements MigrationInterface
{
    name = 'AddOrganisationSubscriptionStatus1787000000000';

    private read(file: string): string {
        return readFileSync(join(__dirname, file), 'utf8').trim();
    }

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            this.read('1787000000000-add_organisation_subscription_status.sql'),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Restores the pre-Stripe "+7 days" stamp — the only deadline logic that
        // existed before this migration — so the trigger does not dangle a
        // reference to the column DROP COLUMN removes below.
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION "public"."set_organisation_trial"()
                RETURNS trigger
                LANGUAGE plpgsql
                SET search_path = ''
            AS $$
            BEGIN
                IF NEW.org_type = 'company' THEN
                    NEW.trial_ends_at := now() + interval '7 days';
                ELSE
                    NEW.trial_ends_at := NULL;
                END IF;
                RETURN NEW;
            END;
            $$;
        `);
        await queryRunner.query(`
            ALTER TABLE "public"."organisations"
                DROP COLUMN IF EXISTS "subscription_status";
        `);
    }
}
