import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { UpsertCustomerDto } from './dto/upsert-customer.dto';

/** Minimal Stripe customer shape â€” avoids relying on SDK namespace exports. */
type StripeCustomerObject = {
    id: string;
    name?: string | null;
    phone?: string | null;
    address?: {
        line1?: string | null;
        city?: string | null;
        state?: string | null;
        postal_code?: string | null;
        country?: string | null;
    } | null;
    metadata?: Record<string, string>;
    deleted?: boolean;
};

/** Thin DB-only row â€” no PII columns. */
interface DbRow {
    id: string;
    organisation_id: string;
    stripe_customer_id: string | null;
    customer_location: { type: 'Point'; coordinates: [number, number] } | null;
    created_at: string;
}

/** Full customer returned to callers â€” PII from Stripe, geometry from DB. */
export interface CustomerRow {
    id: string;
    organisation_id: string;
    stripe_customer_id: string | null;
    customer_name: string;
    customer_phone: string;
    customer_address: string;
    customer_suburb: string;
    customer_state: string;
    customer_postcode: string;
    customer_country: string;
    customer_location: { type: 'Point'; coordinates: [number, number] } | null;
    created_at: string;
}

@Injectable()
export class CustomersService {
    private readonly logger = new Logger(CustomersService.name);

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly orgs: OrganisationsService,
    ) {}

    // â”€â”€ Write operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    async createCustomer(organisationId: string, dto: UpsertCustomerDto): Promise<CustomerRow> {
        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        const customerId = randomUUID();

        const stripeCustomerId = stripeAccountId
            ? await this.createStripeCustomer(stripeAccountId, customerId, dto, `create:${customerId}`)
            : null;

        const rows: DbRow[] = await this.dataSource.query(
            `INSERT INTO public.customer (id, organisation_id, stripe_customer_id, customer_location)
             VALUES ($1, $2, $3, ST_SetSRID(ST_Point($4, $5), 4326))
             RETURNING id, organisation_id, stripe_customer_id,
                       ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at`,
            [customerId, organisationId, stripeCustomerId, dto.lon, dto.lat],
        );

        return this.mergeRow(rows[0], stripeCustomerId ? await this.fetchStripeCustomer(stripeCustomerId, stripeAccountId!) : null, dto);
    }

    async updateCustomer(organisationId: string, customerId: string, dto: UpsertCustomerDto): Promise<CustomerRow> {
        const rows: DbRow[] = await this.dataSource.query(
            `SELECT id, stripe_customer_id FROM public.customer WHERE id = $1 AND organisation_id = $2`,
            [customerId, organisationId],
        );
        if (!rows[0]) throw new NotFoundException(`Customer ${customerId} not found`);

        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        const currentStripeId = rows[0].stripe_customer_id;

        const stripeCustomerId = stripeAccountId
            ? await this.updateOrCreateStripeCustomer(stripeAccountId, currentStripeId, customerId, dto)
            : currentStripeId;

        const updated: DbRow[] = await this.dataSource.query(
            `UPDATE public.customer
             SET customer_location = ST_SetSRID(ST_Point($1, $2), 4326),
                 stripe_customer_id = $3
             WHERE id = $4 AND organisation_id = $5
             RETURNING id, organisation_id, stripe_customer_id,
                       ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at`,
            [dto.lon, dto.lat, stripeCustomerId, customerId, organisationId],
        );
        if (!updated[0]) throw new NotFoundException(`Customer ${customerId} not found after update`);

        return this.mergeRow(updated[0], stripeCustomerId && stripeAccountId ? await this.fetchStripeCustomer(stripeCustomerId, stripeAccountId) : null, dto);
    }

    /**
     * Upsert a customer for the booking webhook. Runs outside any DB
     * transaction so the Stripe API call doesn't hold an open connection.
     * Idempotent: same idempotencyKey always produces the same Stripe customer.
     */
    async upsertFromBooking(
        person: { name: string; phone: string; address: { lon: number; lat: number; street: string; suburb: string; state: string; country: string } },
        stripeAccountId: string | null,
        organisationId: string | null,
        idempotencyKey: string,
    ): Promise<string> {
        let stripeCustomerId: string | null = null;

        if (stripeAccountId) {
            try {
                const customer = await this.stripe.customers.create(
                    {
                        name: person.name,
                        phone: person.phone,
                        address: {
                            line1: person.address.street,
                            city: person.address.suburb,
                            state: person.address.state,
                            country: person.address.country,
                        },
                    },
                    { stripeAccount: stripeAccountId, idempotencyKey },
                );
                stripeCustomerId = customer.id;
            } catch (err) {
                this.logger.error(`Stripe customer create failed (${idempotencyKey}): ${String(err)}`);
            }
        }

        if (stripeCustomerId) {
            const rows: { id: string }[] = await this.dataSource.query(
                `INSERT INTO public.customer (id, organisation_id, stripe_customer_id, customer_location)
                 VALUES ($1, $2, $3, ST_SetSRID(ST_Point($4, $5), 4326))
                 ON CONFLICT (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL
                 DO UPDATE SET customer_location = EXCLUDED.customer_location
                 RETURNING id`,
                [randomUUID(), organisationId, stripeCustomerId, person.address.lon, person.address.lat],
            );
            return rows[0].id;
        }

        // No Stripe account â€” store location only; no PII persisted anywhere.
        const rows: { id: string }[] = await this.dataSource.query(
            `INSERT INTO public.customer (id, organisation_id, customer_location)
             VALUES ($1, $2, ST_SetSRID(ST_Point($3, $4), 4326))
             RETURNING id`,
            [randomUUID(), organisationId, person.address.lon, person.address.lat],
        );
        return rows[0].id;
    }

    // â”€â”€ Read operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    async getCustomer(organisationId: string, customerId: string): Promise<CustomerRow> {
        const rows: DbRow[] = await this.dataSource.query(
            `SELECT id, organisation_id, stripe_customer_id,
                    ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at
             FROM public.customer WHERE id = $1 AND organisation_id = $2`,
            [customerId, organisationId],
        );
        if (!rows[0]) throw new NotFoundException(`Customer ${customerId} not found`);

        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        const stripeCustomer = rows[0].stripe_customer_id && stripeAccountId
            ? await this.fetchStripeCustomer(rows[0].stripe_customer_id, stripeAccountId)
            : null;

        return this.mergeRow(rows[0], stripeCustomer, null);
    }

    async listCustomers(organisationId: string, page: number, pageSize: number): Promise<{ data: CustomerRow[]; total: number }> {
        const offset = (page - 1) * pageSize;

        const [rows, countRows]: [DbRow[], [{ count: string }]] = await Promise.all([
            this.dataSource.query(
                `SELECT id, organisation_id, stripe_customer_id,
                        ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at
                 FROM public.customer WHERE organisation_id = $1
                 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
                [organisationId, pageSize, offset],
            ),
            this.dataSource.query(
                `SELECT COUNT(*)::int AS count FROM public.customer WHERE organisation_id = $1`,
                [organisationId],
            ),
        ]);

        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        const data = await this.enrichRows(rows, stripeAccountId);

        return { data, total: Number(countRows[0]?.count ?? 0) };
    }

    async searchCustomers(organisationId: string, query: string): Promise<CustomerRow[]> {
        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        if (!stripeAccountId) return [];

        const escapedQuery = query.replace(/["\\]/g, '\\$&');
        const results = await this.stripe.customers.search(
            { query: `name~"${escapedQuery}"`, limit: 20 },
            { stripeAccount: stripeAccountId },
        ).catch(() => ({ data: [] as StripeCustomerObject[] }));

        if (!results.data.length) return [];

        const stripeIds = results.data.map((c) => c.id);
        const dbRows: DbRow[] = await this.dataSource.query(
            `SELECT id, organisation_id, stripe_customer_id,
                    ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at
             FROM public.customer WHERE stripe_customer_id = ANY($1)`,
            [stripeIds],
        );

        const dbMap = new Map(dbRows.map((r) => [r.stripe_customer_id!, r]));

        return results.data.map((sc) => {
            const dbRow = dbMap.get(sc.id);
            return this.mergeRow(
                dbRow ?? { id: sc.metadata?.db_customer_id ?? sc.id, organisation_id: organisationId, stripe_customer_id: sc.id, customer_location: null, created_at: '' },
                sc,
                null,
            );
        });
    }

    async getCustomersByDbIds(organisationId: string, ids: string[]): Promise<CustomerRow[]> {
        if (!ids.length) return [];

        const rows: DbRow[] = await this.dataSource.query(
            `SELECT id, organisation_id, stripe_customer_id,
                    ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at
             FROM public.customer WHERE id = ANY($1) AND organisation_id = $2`,
            [ids, organisationId],
        );

        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        return this.enrichRows(rows, stripeAccountId);
    }

    async getCustomersByStripeIds(organisationId: string, stripeIds: string[]): Promise<CustomerRow[]> {
        if (!stripeIds.length) return [];

        const rows: DbRow[] = await this.dataSource.query(
            `SELECT id, organisation_id, stripe_customer_id,
                    ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at
             FROM public.customer WHERE stripe_customer_id = ANY($1)`,
            [stripeIds],
        );

        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        return this.enrichRows(rows, stripeAccountId);
    }

    // â”€â”€ Private helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    async resolveStripeAccount(organisationId: string): Promise<string | null> {
        const account = await this.orgs.getStripeAccount(organisationId);
        return account?.stripeAccountId ?? null;
    }

    private async enrichRows(rows: DbRow[], stripeAccountId: string | null): Promise<CustomerRow[]> {
        if (!stripeAccountId) return rows.map((r) => this.mergeRow(r, null, null));

        const stripeCustomers = await Promise.allSettled(
            rows
                .filter((r) => r.stripe_customer_id)
                .map((r) => this.fetchStripeCustomer(r.stripe_customer_id!, stripeAccountId)),
        );

        const stripeMap = new Map<string, StripeCustomerObject>();
        rows.filter((r) => r.stripe_customer_id).forEach((r, i) => {
            const result = stripeCustomers[i];
            if (result.status === 'fulfilled' && result.value) stripeMap.set(r.stripe_customer_id!, result.value);
        });

        return rows.map((r) => this.mergeRow(r, r.stripe_customer_id ? (stripeMap.get(r.stripe_customer_id) ?? null) : null, null));
    }

    private async fetchStripeCustomer(stripeCustomerId: string, stripeAccountId: string): Promise<StripeCustomerObject | null> {
        try {
            const customer = await this.stripe.customers.retrieve(
                stripeCustomerId,
                undefined,
                { stripeAccount: stripeAccountId },
            );
            if ((customer as any).deleted) return null;
            return customer as unknown as StripeCustomerObject;
        } catch {
            return null;
        }
    }

    private mergeRow(row: DbRow, stripeCustomer: StripeCustomerObject | null, dto: UpsertCustomerDto | null): CustomerRow {
        const addr = stripeCustomer?.address ?? null;
        return {
            id: row.id,
            organisation_id: row.organisation_id,
            stripe_customer_id: row.stripe_customer_id,
            customer_name: stripeCustomer?.name ?? dto?.name ?? '',
            customer_phone: stripeCustomer?.phone ?? dto?.phone ?? '',
            customer_address: addr?.line1 ?? dto?.address?.street ?? '',
            customer_suburb: addr?.city ?? dto?.address?.suburb ?? '',
            customer_state: addr?.state ?? dto?.address?.state ?? '',
            customer_postcode: addr?.postal_code ?? dto?.address?.postcode ?? '',
            customer_country: addr?.country ?? dto?.address?.country ?? '',
            customer_location: row.customer_location,
            created_at: row.created_at,
        };
    }

    private async createStripeCustomer(
        stripeAccountId: string,
        dbCustomerId: string,
        dto: UpsertCustomerDto,
        idempotencyKey: string,
    ): Promise<string | null> {
        try {
            const customer = await this.stripe.customers.create(
                {
                    name: dto.name,
                    phone: dto.phone,
                    address: {
                        line1: dto.address.street,
                        city: dto.address.suburb,
                        state: dto.address.state,
                        postal_code: dto.address.postcode,
                        country: dto.address.country,
                    },
                    metadata: { db_customer_id: dbCustomerId },
                },
                { stripeAccount: stripeAccountId, idempotencyKey },
            );
            return customer.id;
        } catch (err) {
            this.logger.error(`Stripe customer create failed (${dbCustomerId}): ${String(err)}`);
            return null;
        }
    }

    private async updateOrCreateStripeCustomer(
        stripeAccountId: string,
        currentStripeId: string | null,
        dbCustomerId: string,
        dto: UpsertCustomerDto,
    ): Promise<string | null> {
        const addressParams = {
            line1: dto.address.street,
            city: dto.address.suburb,
            state: dto.address.state,
            postal_code: dto.address.postcode,
            country: dto.address.country,
        };
        try {
            if (currentStripeId) {
                await this.stripe.customers.update(
                    currentStripeId,
                    { name: dto.name, phone: dto.phone, address: addressParams },
                    { stripeAccount: stripeAccountId },
                );
                return currentStripeId;
            }
            const created = await this.stripe.customers.create(
                {
                    name: dto.name,
                    phone: dto.phone,
                    address: addressParams,
                    metadata: { db_customer_id: dbCustomerId },
                },
                { stripeAccount: stripeAccountId, idempotencyKey: `update-create:${dbCustomerId}` },
            );
            return created.id;
        } catch (err) {
            this.logger.error(`Stripe customer update failed (${dbCustomerId}): ${String(err)}`);
            return currentStripeId;
        }
    }
}


