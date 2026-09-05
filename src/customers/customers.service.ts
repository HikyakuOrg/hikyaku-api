import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { UpsertCustomerDto } from './dto/upsert-customer.dto';

/**
 * DB row — the database is the canonical source of truth for customer details.
 * Stripe is only an optional downstream link (stripe_customer_id), populated when
 * an org has enabled payment features.
 */
interface DbRow {
    id: string;
    organisation_id: string;
    stripe_customer_id: string | null;
    shopify_customer_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    customer_address: string | null;
    customer_suburb: string | null;
    customer_state: string | null;
    customer_postcode: string | null;
    customer_country: string | null;
    geocode_confidence: number | null;
    pelias_gid: string | null;
    pelias_raw: unknown | null;
    customer_location: { type: 'Point'; coordinates: [number, number] } | null;
    created_at: string;
}

/** Full customer returned to callers — all fields come from the DB. */
export interface CustomerRow {
    id: string;
    organisation_id: string;
    stripe_customer_id: string | null;
    shopify_customer_id: string | null;
    customer_name: string;
    customer_phone: string;
    customer_email: string;
    customer_address: string;
    customer_suburb: string;
    customer_state: string;
    customer_postcode: string;
    customer_country: string;
    geocode_confidence: number | null;
    pelias_gid: string | null;
    pelias_raw: unknown | null;
    customer_location: { type: 'Point'; coordinates: [number, number] } | null;
    created_at: string;
}

/** Columns selected on every read. Location is emitted as GeoJSON. */
const SELECT_COLS = `id, organisation_id, stripe_customer_id, shopify_customer_id,
    customer_name, customer_phone, customer_email,
    customer_address, customer_suburb, customer_state, customer_postcode, customer_country,
    geocode_confidence, pelias_gid, pelias_raw,
    ST_AsGeoJSON(customer_location)::jsonb AS customer_location, created_at`;

@Injectable()
export class CustomersService {
    private readonly logger = new Logger(CustomersService.name);

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly orgs: OrganisationsService,
    ) {}

    // ── Write operations ────────────────────────────────────────────────────────

    async createCustomer(
        organisationId: string,
        dto: UpsertCustomerDto,
    ): Promise<CustomerRow> {
        const customerId = randomUUID();

        const rows: DbRow[] = await this.dataSource.query(
            `INSERT INTO public.customer (
                id, organisation_id,
                customer_name, customer_phone, customer_email,
                customer_address, customer_suburb, customer_state, customer_postcode, customer_country,
                geocode_confidence, pelias_gid, pelias_raw,
                customer_location
             ) VALUES (
                $1, $2,
                $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13::jsonb,
                ST_SetSRID(ST_Point($14, $15), 4326)
             )
             RETURNING ${SELECT_COLS}`,
            [
                customerId,
                organisationId,
                dto.name,
                dto.phone,
                dto.email ?? null,
                dto.address.street,
                dto.address.suburb,
                dto.address.state,
                dto.address.postcode,
                dto.address.country,
                dto.confidence ?? null,
                dto.peliasGid ?? null,
                dto.peliasRaw ? JSON.stringify(dto.peliasRaw) : null,
                dto.lon,
                dto.lat,
            ],
        );

        // Optional Stripe sync — only when the org has enabled payment features.
        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        if (stripeAccountId) {
            const stripeCustomerId = await this.createStripeCustomer(
                stripeAccountId,
                customerId,
                dto,
                `create:${customerId}`,
            );
            if (stripeCustomerId) {
                await this.dataSource.query(
                    `UPDATE public.customer SET stripe_customer_id = $1 WHERE id = $2`,
                    [stripeCustomerId, customerId],
                );
                rows[0].stripe_customer_id = stripeCustomerId;
            }
        }

        return this.mapRow(rows[0]);
    }

    async updateCustomer(
        organisationId: string,
        customerId: string,
        dto: UpsertCustomerDto,
    ): Promise<CustomerRow> {
        const existing: { stripe_customer_id: string | null }[] =
            await this.dataSource.query(
                `SELECT stripe_customer_id FROM public.customer WHERE id = $1 AND organisation_id = $2`,
                [customerId, organisationId],
            );
        if (!existing[0])
            throw new NotFoundException(`Customer ${customerId} not found`);

        // Optional Stripe sync — keep the linked Stripe customer in step when payments are on.
        const stripeAccountId = await this.resolveStripeAccount(organisationId);
        const stripeCustomerId = stripeAccountId
            ? await this.updateOrCreateStripeCustomer(
                  stripeAccountId,
                  existing[0].stripe_customer_id,
                  customerId,
                  dto,
              )
            : existing[0].stripe_customer_id;

        // No RETURNING here: TypeORM resolves an UPDATE to [rows, rowCount], so
        // reading the result as rows yields the rows array at index 0 rather
        // than a row. The updated record is re-read through getCustomer below,
        // which already maps it and 404s if it has since gone.
        await this.dataSource.query(
            `UPDATE public.customer SET
                customer_name = $1, customer_phone = $2, customer_email = $3,
                customer_address = $4, customer_suburb = $5, customer_state = $6,
                customer_postcode = $7, customer_country = $8,
                geocode_confidence = $9, pelias_gid = $10, pelias_raw = $11::jsonb,
                customer_location = ST_SetSRID(ST_Point($12, $13), 4326),
                stripe_customer_id = $14
             WHERE id = $15 AND organisation_id = $16`,
            [
                dto.name,
                dto.phone,
                dto.email ?? null,
                dto.address.street,
                dto.address.suburb,
                dto.address.state,
                dto.address.postcode,
                dto.address.country,
                dto.confidence ?? null,
                dto.peliasGid ?? null,
                dto.peliasRaw ? JSON.stringify(dto.peliasRaw) : null,
                dto.lon,
                dto.lat,
                stripeCustomerId,
                customerId,
                organisationId,
            ],
        );

        return this.getCustomer(organisationId, customerId);
    }

    /**
     * Upsert a customer for the booking webhook. The DB always stores the full
     * details; Stripe is synced best-effort afterwards when the org has payments
     * enabled. Idempotent on (organisation_id, phone) — a retried booking webhook
     * updates the same customer row instead of duplicating it.
     */
    async upsertFromBooking(
        person: {
            name: string;
            phone: string;
            email?: string | null;
            address: {
                lon: number;
                lat: number;
                street: string;
                suburb: string;
                state: string;
                postcode?: string | null;
                country: string;
            };
        },
        stripeAccountId: string | null,
        organisationId: string | null,
        idempotencyKey: string,
    ): Promise<string> {
        const customerId = await this.upsertCustomerRow(organisationId, person);

        // Best-effort Stripe sync — never blocks the booking on a Stripe failure.
        if (stripeAccountId) {
            try {
                const customer = await this.stripe.customers.create(
                    {
                        name: person.name,
                        phone: person.phone,
                        email: person.email ?? undefined,
                        address: {
                            line1: person.address.street,
                            city: person.address.suburb,
                            state: person.address.state,
                            postal_code: person.address.postcode ?? undefined,
                            country: person.address.country,
                        },
                        metadata: { db_customer_id: customerId },
                    },
                    { stripeAccount: stripeAccountId, idempotencyKey },
                );
                await this.dataSource.query(
                    `UPDATE public.customer SET stripe_customer_id = $1 WHERE id = $2`,
                    [customer.id, customerId],
                );
            } catch (err) {
                this.logger.error(
                    `Stripe customer sync failed (${idempotencyKey}): ${String(err)}`,
                );
            }
        }

        return customerId;
    }

    /**
     * Upsert a customer for a Shopify `order.paid` webhook. DB-only — a
     * Shopify order is paid entirely inside Shopify, so there is no Stripe
     * payment for a Stripe Customer object to attach to. Syncing one anyway
     * would just be a third, functionless copy of this person's PII (see
     * upsertFromBooking, which syncs to Stripe precisely because a Stripe
     * payment *is* happening in that flow).
     *
     * Unlike a booking, phone is frequently absent from Shopify's delivery
     * payload, so this goes through the same three-tier (phone → email →
     * name) fallback as upsertFromBooking via upsertCustomerRow — see that
     * method for the exact matching rules.
     */
    async upsertFromShopifyOrder(
        organisationId: string,
        person: {
            name: string;
            phone: string | null;
            email?: string | null;
            address: {
                lon: number;
                lat: number;
                street: string;
                suburb: string;
                state: string;
                postcode?: string | null;
                country: string;
            };
            confidence?: number | null;
            peliasGid?: string | null;
            peliasRaw?: Record<string, unknown> | null;
        },
        shopifyCustomerId: string | null,
    ): Promise<string> {
        const customerId = await this.upsertCustomerRow(organisationId, person);

        if (shopifyCustomerId) {
            await this.dataSource.query(
                `UPDATE public.customer SET shopify_customer_id = $1 WHERE id = $2`,
                [shopifyCustomerId, customerId],
            );
        }

        return customerId;
    }

    // ── Read operations ───────────────────────────────────────────────────────────

    async getCustomer(
        organisationId: string,
        customerId: string,
    ): Promise<CustomerRow> {
        const rows: DbRow[] = await this.dataSource.query(
            `SELECT ${SELECT_COLS} FROM public.customer WHERE id = $1 AND organisation_id = $2`,
            [customerId, organisationId],
        );
        if (!rows[0])
            throw new NotFoundException(`Customer ${customerId} not found`);
        return this.mapRow(rows[0]);
    }

    async listCustomers(
        organisationId: string,
        page: number,
        pageSize: number,
    ): Promise<{ data: CustomerRow[]; total: number }> {
        const offset = (page - 1) * pageSize;

        const [rows, countRows]: [DbRow[], [{ count: string }]] =
            await Promise.all([
                this.dataSource.query(
                    `SELECT ${SELECT_COLS} FROM public.customer WHERE organisation_id = $1
                 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
                    [organisationId, pageSize, offset],
                ),
                this.dataSource.query(
                    `SELECT COUNT(*)::int AS count FROM public.customer WHERE organisation_id = $1`,
                    [organisationId],
                ),
            ]);

        return {
            data: rows.map((r) => this.mapRow(r)),
            total: Number(countRows[0]?.count ?? 0),
        };
    }

    /**
     * Trigram/ILIKE search over name, phone and email — scoped to the org and
     * backed by the gin_trgm indexes. Works for every org, with or without Stripe.
     */
    async searchCustomers(
        organisationId: string,
        query: string,
    ): Promise<CustomerRow[]> {
        const trimmed = query.trim();
        if (trimmed.length < 2) return [];

        const rows: DbRow[] = await this.dataSource.query(
            `SELECT ${SELECT_COLS} FROM public.customer
             WHERE organisation_id = $1
               AND (customer_name ILIKE $2 OR customer_phone ILIKE $2 OR customer_email ILIKE $2)
             ORDER BY created_at DESC LIMIT 20`,
            [organisationId, `%${trimmed}%`],
        );

        return rows.map((r) => this.mapRow(r));
    }

    async getCustomersByDbIds(
        organisationId: string,
        ids: string[],
    ): Promise<CustomerRow[]> {
        if (!ids.length) return [];

        const rows: DbRow[] = await this.dataSource.query(
            `SELECT ${SELECT_COLS} FROM public.customer WHERE id = ANY($1) AND organisation_id = $2`,
            [ids, organisationId],
        );

        return rows.map((r) => this.mapRow(r));
    }

    async getCustomersByStripeIds(
        organisationId: string,
        stripeIds: string[],
    ): Promise<CustomerRow[]> {
        if (!stripeIds.length) return [];

        const rows: DbRow[] = await this.dataSource.query(
            `SELECT ${SELECT_COLS} FROM public.customer
             WHERE stripe_customer_id = ANY($1) AND organisation_id = $2`,
            [stripeIds, organisationId],
        );

        return rows.map((r) => this.mapRow(r));
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /**
     * Shared DB-upsert-by-identity used by both upsertFromBooking and
     * upsertFromShopifyOrder. Picks the strongest available identifier as the
     * ON CONFLICT target, in descending reliability: phone, then email (only
     * among rows that also lack a phone), then name (only among rows that
     * lack both). Each fallback tier is scoped so it can only ever merge into
     * an equally-weak-identity row — never overwrite one that already has
     * stronger verified data. See customer_org_phone_unique /
     * customer_org_email_unique / customer_org_name_unique in the schema.
     *
     * geocode_confidence/pelias_gid/pelias_raw are only ever supplied by the
     * geocoded manual-entry endpoint (UpsertCustomerDto) — booking and
     * Shopify callers never pass them. On conflict they're preserved via
     * COALESCE rather than overwritten, so a later booking/Shopify touch
     * can't blank out an existing row's geocode provenance.
     */
    private async upsertCustomerRow(
        organisationId: string | null,
        person: {
            name: string;
            phone: string | null;
            email?: string | null;
            address: {
                lon: number;
                lat: number;
                street: string;
                suburb: string;
                state: string;
                postcode?: string | null;
                country: string;
            };
            confidence?: number | null;
            peliasGid?: string | null;
            peliasRaw?: Record<string, unknown> | null;
        },
    ): Promise<string> {
        const conflictClause = person.phone
            ? `ON CONFLICT (organisation_id, lower(customer_phone)) WHERE customer_phone IS NOT NULL`
            : person.email
              ? `ON CONFLICT (organisation_id, lower(customer_email)) WHERE customer_email IS NOT NULL AND customer_phone IS NULL`
              : `ON CONFLICT (organisation_id, lower(customer_name)) WHERE customer_name IS NOT NULL AND customer_phone IS NULL AND customer_email IS NULL`;

        const rows: { id: string }[] = await this.dataSource.query(
            `INSERT INTO public.customer (
                id, organisation_id,
                customer_name, customer_phone, customer_email,
                customer_address, customer_suburb, customer_state, customer_postcode, customer_country,
                geocode_confidence, pelias_gid, pelias_raw,
                customer_location
             ) VALUES (
                $1, $2,
                $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13::jsonb,
                ST_SetSRID(ST_Point($14, $15), 4326)
             )
             ${conflictClause}
             DO UPDATE SET
                customer_name = EXCLUDED.customer_name,
                customer_email = EXCLUDED.customer_email,
                customer_address = EXCLUDED.customer_address,
                customer_suburb = EXCLUDED.customer_suburb,
                customer_state = EXCLUDED.customer_state,
                customer_postcode = EXCLUDED.customer_postcode,
                customer_country = EXCLUDED.customer_country,
                customer_location = EXCLUDED.customer_location,
                geocode_confidence = COALESCE(EXCLUDED.geocode_confidence, public.customer.geocode_confidence),
                pelias_gid = COALESCE(EXCLUDED.pelias_gid, public.customer.pelias_gid),
                pelias_raw = COALESCE(EXCLUDED.pelias_raw, public.customer.pelias_raw)
             RETURNING id`,
            [
                randomUUID(),
                organisationId,
                person.name,
                person.phone,
                person.email ?? null,
                person.address.street,
                person.address.suburb,
                person.address.state,
                person.address.postcode ?? null,
                person.address.country,
                person.confidence ?? null,
                person.peliasGid ?? null,
                person.peliasRaw ? JSON.stringify(person.peliasRaw) : null,
                person.address.lon,
                person.address.lat,
            ],
        );

        return rows[0].id;
    }

    async resolveStripeAccount(organisationId: string): Promise<string | null> {
        const account = await this.orgs.getStripeAccount(organisationId);
        return account?.stripeAccountId ?? null;
    }

    private mapRow(row: DbRow): CustomerRow {
        return {
            id: row.id,
            organisation_id: row.organisation_id,
            stripe_customer_id: row.stripe_customer_id,
            shopify_customer_id: row.shopify_customer_id,
            customer_name: row.customer_name ?? '',
            customer_phone: row.customer_phone ?? '',
            customer_email: row.customer_email ?? '',
            customer_address: row.customer_address ?? '',
            customer_suburb: row.customer_suburb ?? '',
            customer_state: row.customer_state ?? '',
            customer_postcode: row.customer_postcode ?? '',
            customer_country: row.customer_country ?? '',
            geocode_confidence: row.geocode_confidence,
            pelias_gid: row.pelias_gid,
            pelias_raw: row.pelias_raw,
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
                    email: dto.email ?? undefined,
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
            this.logger.error(
                `Stripe customer create failed (${dbCustomerId}): ${String(err)}`,
            );
            return null;
        }
    }

    private async updateOrCreateStripeCustomer(
        stripeAccountId: string,
        currentStripeId: string | null,
        dbCustomerId: string,
        dto: UpsertCustomerDto,
    ): Promise<string | null> {
        const params = {
            name: dto.name,
            phone: dto.phone,
            email: dto.email ?? undefined,
            address: {
                line1: dto.address.street,
                city: dto.address.suburb,
                state: dto.address.state,
                postal_code: dto.address.postcode,
                country: dto.address.country,
            },
        };
        try {
            if (currentStripeId) {
                await this.stripe.customers.update(currentStripeId, params, {
                    stripeAccount: stripeAccountId,
                });
                return currentStripeId;
            }
            const created = await this.stripe.customers.create(
                { ...params, metadata: { db_customer_id: dbCustomerId } },
                {
                    stripeAccount: stripeAccountId,
                    idempotencyKey: `update-create:${dbCustomerId}`,
                },
            );
            return created.id;
        } catch (err) {
            this.logger.error(
                `Stripe customer update failed (${dbCustomerId}): ${String(err)}`,
            );
            return currentStripeId;
        }
    }
}
