import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { SupabaseClient } from '@supabase/supabase-js';
import { DataSource, Repository } from 'typeorm';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { toStripeMinorUnits } from 'src/common/money';
import { toE164OrNull } from 'src/common/phone';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { IssuingCard } from './entities/issuing-card.entity';

/**
 * Param + result types are derived from the Stripe instance (indexed access)
 * rather than the `Stripe.*` namespace — the namespace doesn't resolve under
 * `module: nodenext` (see stripe.provider.ts).
 */
type CardCreateParams = Parameters<StripeClient['issuing']['cards']['create']>[0];
type AllowedCategory = NonNullable<
    NonNullable<CardCreateParams['spending_controls']>['allowed_categories']
>[number];
// Derive from `list().data[number]` rather than `retrieve()` so the types are
// bare T (e.g. Stripe.Issuing.Card) rather than Stripe.Response<T> — list items
// don't carry `lastResponse`, and `create()`/`update()` results (which DO carry
// it) are still assignable to bare T since Response<T> extends T.
type StripeCard = Awaited<
    ReturnType<StripeClient['issuing']['cards']['list']>
>['data'][number];
type StripeCardholder = Awaited<
    ReturnType<StripeClient['issuing']['cardholders']['list']>
>['data'][number];
type StripeTransaction = Awaited<
    ReturnType<StripeClient['issuing']['transactions']['list']>
>['data'][number];

export const SPENDING_INTERVALS = [
    'per_authorization',
    'daily',
    'weekly',
    'monthly',
    'yearly',
    'all_time',
] as const;
export type SpendingInterval = (typeof SPENDING_INTERVALS)[number];

/** MCCs that count as a vehicle fuel stop: 5542 pay-at-pump, 5541 service station.
 * (5983 "fuel_dealers" is heating-fuel/non-automotive and isn't a Stripe category.) */
const FUEL_CATEGORIES: AllowedCategory[] = [
    'automated_fuel_dispensers',
    'service_stations',
];

export interface IssueCardInput {
    driverId: string;
    vehicleId?: string | null;
    /** Major-unit spend cap (e.g. 150 == $150.00). Omit for no card-level limit. */
    spendingLimitMajor?: number | null;
    /** Defaults to 'daily'. */
    interval?: SpendingInterval;
    /** Card currency — must match the platform Stripe account (usd/eur/gbp). */
    currency: string;
}

/**
 * Wire shape returned to the frontend. We keep the same field names as the
 * pre-on-demand version so the client (lib/actions/issuing.ts → fuel-cards-client.tsx)
 * needs no change. `id` is now the Stripe card id (`ic_…`) rather than a local UUID.
 */
export interface CardDto {
    id: string;
    organisationId: string;
    cardholderId: string;
    vehicleId: string | null;
    stripeCardId: string;
    last4: string | null;
    type: string;
    currency: string;
    status: string;
    spendingLimitMinor: number | null;
    spendingInterval: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TransactionDto {
    id: string;
    organisationId: string;
    cardId: string | null;
    cardholderId: string | null;
    vehicleId: string | null;
    driverId: string | null;
    stripeTransactionId: string;
    stripeAuthorizationId: string | null;
    type: string;
    amountMinor: number;
    currency: string;
    merchantName: string | null;
    merchantCategory: string | null;
    merchantCity: string | null;
    merchantCountry: string | null;
    authorizedAt: string | null;
    createdAt: string;
}

@Injectable()
export class IssuingService {
    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
        @InjectRepository(IssuingCard)
        private readonly cardRepo: Repository<IssuingCard>,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly orgs: OrganisationsService,
    ) {}

    /**
     * Resolve the org's connected account, asserting it can issue. Every Issuing
     * API call must be scoped to this account (Stripe-Account header) so cards
     * live on — and are funded by — the org, not the platform. Used by mutating
     * calls; list endpoints use {@link getStripeAccountIdOrNull} so an org that
     * hasn't completed onboarding sees an empty list rather than an error.
     */
    private async getStripeAccountId(organisationId: string): Promise<string> {
        const stripe = await this.orgs.getStripeAccount(organisationId);
        if (!stripe?.stripeAccountId || stripe.cardIssuingStatus !== 'active') {
            throw new BadRequestException(
                'Card issuing is not active for this organisation. Set up payments in Settings → Payments first.',
            );
        }
        return stripe.stripeAccountId;
    }

    /** Lenient variant for read-only listings — returns null if the org has no
     * connected account or issuing isn't active yet (callers should return []). */
    private async getStripeAccountIdOrNull(
        organisationId: string,
    ): Promise<string | null> {
        const stripe = await this.orgs.getStripeAccount(organisationId);
        if (!stripe?.stripeAccountId || stripe.cardIssuingStatus !== 'active') {
            return null;
        }
        return stripe.stripeAccountId;
    }

    /**
     * Return the Stripe cardholder id for a driver, creating one if needed.
     *
     * On first issue: creates the Stripe cardholder and returns its id.
     * On subsequent issues: looks up any existing card for this driver in the
     * local `issuing_cards` table, then retrieves that card from Stripe to read
     * back its cardholder id (one extra Stripe call, acceptable given card
     * issuance is infrequent).
     */
    async ensureCardholder(
        organisationId: string,
        driverId: string,
        stripeAccount: string,
    ): Promise<string> {
        const existing = await this.cardRepo.findOne({
            where: { organisationId, driverId },
            select: ['stripeCardId'],
        });
        if (existing) {
            const card = await this.stripe.issuing.cards.retrieve(
                existing.stripeCardId,
                {},
                { stripeAccount },
            );
            return typeof card.cardholder === 'string'
                ? card.cardholder
                : card.cardholder.id;
        }

        const identity = await this.getDriverIdentity(driverId);
        const billing = await this.getDriverBillingAddress(
            organisationId,
            driverId,
        );

        const cardholder = await this.stripe.issuing.cardholders.create(
            {
                type: 'individual',
                name: identity.name,
                email: identity.email ?? undefined,
                phone_number: identity.phone ?? undefined,
                billing: { address: billing },
                metadata: { organisationId, driverId },
            },
            { stripeAccount },
        );
        return cardholder.id;
    }

    /**
     * Issue a virtual fuel card to a driver: restricted to fuel MCCs and capped
     * by an optional spend limit. Stripe auto-declines anything else — no
     * real-time authorization webhook needed. The driver/vehicle/org linkage is
     * stored in the local `issuing_cards` table (fast lookup) and mirrored into
     * Stripe card metadata (so `listTransactions` can filter without the DB).
     */
    async issueCard(
        organisationId: string,
        input: IssueCardInput,
    ): Promise<CardDto> {
        const stripeAccount = await this.getStripeAccountId(organisationId);
        const stripeCardholderId = await this.ensureCardholder(
            organisationId,
            input.driverId,
            stripeAccount,
        );

        if (input.vehicleId) {
            await this.assertVehicleInOrg(organisationId, input.vehicleId);
        }

        const interval: SpendingInterval = input.interval ?? 'daily';
        const limitMinor =
            input.spendingLimitMajor != null
                ? toStripeMinorUnits(input.spendingLimitMajor, input.currency)
                : null;

        const metadata: Record<string, string> = {
            organisationId,
            driverId: input.driverId,
        };
        if (input.vehicleId) metadata.vehicleId = input.vehicleId;

        const params: CardCreateParams = {
            cardholder: stripeCardholderId,
            currency: input.currency.toLowerCase(),
            type: 'virtual',
            status: 'active',
            spending_controls: {
                allowed_categories: FUEL_CATEGORIES,
                spending_limits:
                    limitMinor != null
                        ? [
                              {
                                  amount: limitMinor,
                                  interval,
                                  categories: FUEL_CATEGORIES,
                              },
                          ]
                        : undefined,
            },
            metadata,
        };

        const card = await this.stripe.issuing.cards.create(params, {
            stripeAccount,
        });

        await this.cardRepo.save(
            this.cardRepo.create({
                organisationId,
                driverId: input.driverId,
                stripeCardId: card.id,
            }),
        );

        return this.toCardDto(card, organisationId);
    }

    async listCards(organisationId: string): Promise<CardDto[]> {
        const stripeAccount = await this.getStripeAccountIdOrNull(organisationId);
        if (!stripeAccount) return [];
        const cards = await this.stripe.issuing.cards.list(
            { limit: 100 },
            { stripeAccount },
        );
        return cards.data.map((c) => this.toCardDto(c, organisationId));
    }

    /**
     * List issuing transactions for the org. Filters by driver/vehicle are
     * applied in memory after expanding `card` + `cardholder`, since neither
     * Stripe's `card`/`cardholder` query params nor metadata search line up
     * with our (driver, vehicle) inputs. At limit=100 this is cheap.
     */
    async listTransactions(
        organisationId: string,
        filters: { driverId?: string; vehicleId?: string } = {},
    ): Promise<TransactionDto[]> {
        const stripeAccount = await this.getStripeAccountIdOrNull(organisationId);
        if (!stripeAccount) return [];

        const txns = await this.stripe.issuing.transactions.list(
            {
                limit: 100,
                expand: ['data.card', 'data.cardholder'],
            },
            { stripeAccount },
        );

        let data = txns.data;
        if (filters.driverId) {
            data = data.filter((t) => {
                const ch = typeof t.cardholder === 'object' ? t.cardholder : null;
                return ch?.metadata?.driverId === filters.driverId;
            });
        }
        if (filters.vehicleId) {
            data = data.filter((t) => {
                const c = typeof t.card === 'object' ? t.card : null;
                return c?.metadata?.vehicleId === filters.vehicleId;
            });
        }
        return data.map((t) => this.toTransactionDto(t, organisationId));
    }

    /** Freeze ('inactive') or permanently cancel ('canceled') a card. */
    async setCardStatus(
        organisationId: string,
        stripeCardId: string,
        status: 'active' | 'inactive' | 'canceled',
    ): Promise<CardDto> {
        const stripeAccount = await this.getStripeAccountId(organisationId);
        const card = await this.stripe.issuing.cards.update(
            stripeCardId,
            { status },
            { stripeAccount },
        );
        return this.toCardDto(card, organisationId);
    }

    /**
     * Mint a short-lived ephemeral key so the client can render full card
     * details with Issuing Elements. The PAN never touches this server.
     */
    async createEphemeralKey(
        organisationId: string,
        stripeCardId: string,
        nonce: string,
        apiVersion: string,
    ): Promise<{ ephemeralKeySecret: string }> {
        const stripeAccount = await this.getStripeAccountId(organisationId);
        const key = await this.stripe.ephemeralKeys.create(
            { issuing_card: stripeCardId, nonce },
            { apiVersion, stripeAccount },
        );
        if (!key.secret) {
            throw new Error('Stripe did not return an ephemeral key secret');
        }
        return { ephemeralKeySecret: key.secret };
    }

    private toCardDto(card: StripeCard, organisationId: string): CardDto {
        const limit = card.spending_controls?.spending_limits?.[0];
        const cardholderId =
            typeof card.cardholder === 'string'
                ? card.cardholder
                : (card.cardholder?.id ?? '');
        const createdIso = new Date(card.created * 1000).toISOString();
        return {
            id: card.id,
            organisationId,
            cardholderId,
            vehicleId: card.metadata?.vehicleId ?? null,
            stripeCardId: card.id,
            last4: card.last4 ?? null,
            type: card.type ?? 'virtual',
            currency: card.currency,
            status: card.status,
            spendingLimitMinor: limit?.amount ?? null,
            spendingInterval: limit?.interval ?? null,
            createdAt: createdIso,
            // Stripe doesn't expose an updated_at on cards; the frontend doesn't
            // display it, so we mirror created to keep the shape stable.
            updatedAt: createdIso,
        };
    }

    private toTransactionDto(
        txn: StripeTransaction,
        organisationId: string,
    ): TransactionDto {
        const card = typeof txn.card === 'object' ? txn.card : null;
        const cardholder =
            typeof txn.cardholder === 'object' ? txn.cardholder : null;
        const createdIso = txn.created
            ? new Date(txn.created * 1000).toISOString()
            : new Date().toISOString();
        return {
            id: txn.id,
            organisationId,
            cardId:
                typeof txn.card === 'string'
                    ? txn.card
                    : (txn.card?.id ?? null),
            cardholderId:
                typeof txn.cardholder === 'string'
                    ? txn.cardholder
                    : (txn.cardholder?.id ?? null),
            vehicleId: card?.metadata?.vehicleId ?? null,
            driverId: cardholder?.metadata?.driverId ?? null,
            stripeTransactionId: txn.id,
            stripeAuthorizationId:
                typeof txn.authorization === 'string'
                    ? txn.authorization
                    : (txn.authorization?.id ?? null),
            type: txn.type === 'refund' ? 'refund' : 'capture',
            // Issuing reports spend as a negative amount; expose the magnitude.
            amountMinor: Math.abs(txn.amount),
            currency: txn.currency,
            merchantName: txn.merchant_data?.name ?? null,
            merchantCategory: txn.merchant_data?.category ?? null,
            merchantCity: txn.merchant_data?.city ?? null,
            merchantCountry: txn.merchant_data?.country ?? null,
            authorizedAt: txn.created
                ? new Date(txn.created * 1000).toISOString()
                : null,
            createdAt: createdIso,
        };
    }

    private async getDriverIdentity(
        driverId: string,
    ): Promise<{ name: string; email: string | null; phone: string | null }> {
        const { data, error } =
            await this.supabase.auth.admin.getUserById(driverId);
        if (error || !data.user) {
            throw new NotFoundException(`Driver ${driverId} not found`);
        }
        const user = data.user;
        const displayName =
            (user.user_metadata?.display_name as string | undefined) ??
            user.email ??
            null;
        if (!displayName) {
            throw new BadRequestException(
                'Driver has no display name or email to use as cardholder name',
            );
        }
        return {
            name: displayName,
            email: user.email ?? null,
            phone: toE164OrNull(user.phone ?? ''),
        };
    }

    private async getDriverBillingAddress(
        organisationId: string,
        driverId: string,
    ): Promise<{
        line1: string;
        city: string;
        state: string;
        postal_code: string;
        country: string;
    }> {
        const rows: {
            warehouse_address: string;
            warehouse_city: string;
            warehouse_state: string;
            warehouse_zipcode: string;
            warehouse_country: string;
        }[] = await this.dataSource.query(
            `SELECT w.warehouse_address, w.warehouse_city, w.warehouse_state,
                    w.warehouse_zipcode, w.warehouse_country
             FROM drivers d
             JOIN warehouse w ON w.id = d.warehouse_id
             WHERE d.id = $1 AND d.organisation_id = $2`,
            [driverId, organisationId],
        );
        if (rows.length === 0) {
            throw new BadRequestException(
                'Driver has no assigned warehouse; a billing address is required to create a cardholder',
            );
        }
        const w = rows[0];
        // country must be an ISO 3166-1 alpha-2 code (e.g. "US") for Stripe.
        return {
            line1: w.warehouse_address,
            city: w.warehouse_city,
            state: w.warehouse_state,
            postal_code: w.warehouse_zipcode,
            country: w.warehouse_country,
        };
    }

    private async assertVehicleInOrg(
        organisationId: string,
        vehicleId: string,
    ): Promise<void> {
        const rows: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM vehicles WHERE id = $1 AND organisation_id = $2`,
            [vehicleId, organisationId],
        );
        if (rows.length === 0) {
            throw new BadRequestException(
                `Vehicle ${vehicleId} not found in this organisation`,
            );
        }
    }
}
