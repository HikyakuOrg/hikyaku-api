import { Client } from 'pg';
import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { OrganisationsService } from '../src/organisations/organisations.service';
import type {
    CatalogProduct,
    ServicesService,
} from '../src/services/services.service';
import { ShippingRateSettingsService } from '../src/integrations/shipping-rate-settings.service';

/**
 * integration_shipping_rate_settings against a real database: the
 * cross-organisation shop guard in the upsert, the CHECKs, and the grants.
 * Pure validation is in src/integrations/shipping-rate-settings.service.spec.ts.
 *
 * Runs only under `pnpm test:e2e`, against DB_MIGRATION_URL or DB_URL with
 * this repo's migrations applied (1790125200000 included); skips otherwise.
 * Every test runs in one transaction that is always rolled back, as in
 * test/dispatch-settings.e2e-spec.ts.
 */

const DB_URL = process.env.DB_MIGRATION_URL ?? process.env.DB_URL;

const describeWithDb = DB_URL ? describe : describe.skip;

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

const SERVICE: CatalogProduct = {
    productId: 'prod_e2e',
    name: 'E2E',
    description: null,
    amountMinor: 1000,
    currency: 'aud',
    currencyOptions: {},
    created: 1,
    pricingUnit: 'per_delivery',
    kind: 'service',
    parentProductId: null,
    defaultPriceId: 'price_e2e',
};

describeWithDb(
    'integration_shipping_rate_settings against a real database',
    () => {
        jest.setTimeout(60_000);

        let client: PgClient;
        let service: ShippingRateSettingsService;

        beforeAll(async () => {
            client = new PgClientCtor({ connectionString: DB_URL! });
            await client.connect();
            const dataSource = {
                async query(sql: string, parameters?: unknown[]) {
                    return (await client.query(sql, parameters)).rows;
                },
            };
            service = new ShippingRateSettingsService(
                dataSource as unknown as DataSource,
                {
                    getStripeAccount: () =>
                        Promise.resolve({ stripeAccountId: 'acct_e2e' }),
                } as unknown as OrganisationsService,
                {
                    fetchActiveProductMap: () =>
                        Promise.resolve(
                            new Map([[SERVICE.productId, SERVICE]]),
                        ),
                } as unknown as ServicesService,
            );
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

        async function createOrganisation(): Promise<{
            organisationId: string;
            userId: string;
        }> {
            const { rows: users } = await client.query<{ id: string }>(
                `INSERT INTO auth.users (id, email)
             VALUES (gen_random_uuid(), gen_random_uuid()::text || '@shipping-rates.test')
             RETURNING id`,
            );
            const userId = users[0].id;
            await client.query(
                `SELECT set_config('request.jwt.claims', $1, true)`,
                [JSON.stringify({ sub: userId, role: 'authenticated' })],
            );
            const { rows } = await client.query<{ id: string }>(
                `INSERT INTO organisations (name, org_type, created_by)
             VALUES ('shipping-rates-' || gen_random_uuid()::text, 'company', $1)
             RETURNING id`,
                [userId],
            );
            return { organisationId: rows[0].id, userId };
        }

        const shop = `e2e-${Date.now()}.myshopify.com`;
        const body = {
            platform: 'shopify',
            shop_domain: shop,
            shop_currency: 'AUD',
            enabled: true,
            service_ids: [SERVICE.productId],
            path: 'live' as const,
        };

        it('stores, updates and deletes a shop’s settings', async () => {
            const { organisationId, userId } = await createOrganisation();

            await service.put(organisationId, userId, body);
            const updated = await service.put(organisationId, userId, {
                ...body,
                enabled: false,
            });
            expect(updated.enabled).toBe(false);

            const found = await service.findByShop(
                'shopify',
                shop.toUpperCase(),
            );
            expect(found?.organisation_id).toBe(organisationId);

            await service.remove(organisationId, 'shopify', shop);
            expect(await service.findByShop('shopify', shop)).toBeNull();
        });

        it('refuses a shop another organisation holds, and leaves its row alone', async () => {
            const a = await createOrganisation();
            const b = await createOrganisation();
            await service.put(a.organisationId, a.userId, body);

            await expect(
                service.put(b.organisationId, b.userId, body),
            ).rejects.toThrow(ConflictException);

            // B's delete does not touch A's row either.
            await service.remove(b.organisationId, 'shopify', shop);
            const found = await service.findByShop('shopify', shop);
            expect(found?.organisation_id).toBe(a.organisationId);
            expect(found?.enabled).toBe(true);
        });

        it('refuses an enabled row without a currency or a service', async () => {
            const { organisationId } = await createOrganisation();
            await client.query('SAVEPOINT s');
            await expect(
                client.query(
                    `INSERT INTO integration_shipping_rate_settings
                    (organisation_id, platform, shop_domain, enabled)
                 VALUES ($1, 'shopify', $2, true)`,
                    [organisationId, shop],
                ),
            ).rejects.toMatchObject({ code: '23514' });
            await client.query('ROLLBACK TO SAVEPOINT s');
        });

        it('is not readable by authenticated', async () => {
            await client.query('SAVEPOINT s');
            await client.query('SET LOCAL ROLE authenticated');
            await expect(
                client.query(
                    'SELECT 1 FROM integration_shipping_rate_settings',
                ),
            ).rejects.toMatchObject({ code: '42501' });
            await client.query('ROLLBACK TO SAVEPOINT s');
        });

        it('grants integrations.shipping_rates.write to a new organisation’s creator', async () => {
            const { organisationId, userId } = await createOrganisation();
            const { rows } = await client.query(
                `SELECT 1 FROM user_permission up
               JOIN app_permission p ON p.id = up.permission_id
              WHERE up.organisation_id = $1 AND up.user_id = $2
                AND p.permission = 'integrations.shipping_rates.write'`,
                [organisationId, userId],
            );
            expect(rows).toHaveLength(1);
        });
    },
);
