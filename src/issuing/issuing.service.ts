import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
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
import { IssuingCardholder } from './entities/issuing-cardholder.entity';
import { IssuingCard } from './entities/issuing-card.entity';
import { IssuingTransaction } from './entities/issuing-transaction.entity';

/**
 * Param types are derived from the Stripe instance (indexed access) rather than
 * the `Stripe.*` namespace — the namespace doesn't resolve under `module:
 * nodenext` (see stripe.provider.ts). This still type-checks the MCC literals.
 */
type CardCreateParams = Parameters<StripeClient['issuing']['cards']['create']>[0];
type AllowedCategory = NonNullable<
    NonNullable<CardCreateParams['spending_controls']>['allowed_categories']
>[number];

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

/** Minimal shape of an Issuing Transaction off the webhook (see stripe-webhook pattern). */
export interface StripeIssuingTransaction {
    id: string;
    type?: string | null;
    amount: number;
    currency: string;
    card?: string | { id: string } | null;
    authorization?: string | { id: string } | null;
    created?: number | null;
    merchant_data?: {
        name?: string | null;
        category?: string | null;
        city?: string | null;
        country?: string | null;
    } | null;
}

@Injectable()
export class IssuingService {
    private readonly logger = new Logger(IssuingService.name);

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
        @InjectRepository(IssuingCardholder)
        private readonly cardholderRepo: Repository<IssuingCardholder>,
        @InjectRepository(IssuingCard)
        private readonly cardRepo: Repository<IssuingCard>,
        @InjectRepository(IssuingTransaction)
        private readonly txnRepo: Repository<IssuingTransaction>,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly orgs: OrganisationsService,
    ) {}

    /**
     * Resolve the org's connected account, asserting it can issue. Every Issuing
     * API call must be scoped to this account (Stripe-Account header) so cards
     * live on — and are funded by — the org, not the platform.
     */
    private async getStripeAccountId(organisationId: string): Promise<string> {
        const org = await this.orgs.getOrFail(organisationId);
        if (!org.stripeAccountId || org.cardIssuingStatus !== 'active') {
            throw new BadRequestException(
                'Card issuing is not active for this organisation. Set up payments in Settings → Payments first.',
            );
        }
        return org.stripeAccountId;
    }

    /**
     * Create (or return the existing) Stripe cardholder for a driver. Idempotent
     * on (organisation, driver): a driver has exactly one cardholder.
     */
    async ensureCardholder(
        organisationId: string,
        driverId: string,
        stripeAccount: string,
    ): Promise<IssuingCardholder> {
        const existing = await this.cardholderRepo.findOne({
            where: { organisationId, driverId },
        });
        if (existing) return existing;

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
            },
            { stripeAccount },
        );

        return this.cardholderRepo.save(
            this.cardholderRepo.create({
                organisationId,
                driverId,
                stripeCardholderId: cardholder.id,
                status: 'active',
            }),
        );
    }

    /**
     * Issue a virtual fuel card to a driver: restricted to fuel MCCs and capped
     * by an optional spend limit. Stripe auto-declines anything else — no
     * real-time authorization webhook needed.
     */
    async issueCard(
        organisationId: string,
        input: IssueCardInput,
    ): Promise<IssuingCard> {
        const stripeAccount = await this.getStripeAccountId(organisationId);
        const cardholder = await this.ensureCardholder(
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

        const params: CardCreateParams = {
            cardholder: cardholder.stripeCardholderId,
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
        };

        const card = await this.stripe.issuing.cards.create(params, {
            stripeAccount,
        });

        return this.cardRepo.save(
            this.cardRepo.create({
                organisationId,
                cardholderId: cardholder.id,
                vehicleId: input.vehicleId ?? null,
                stripeCardId: card.id,
                last4: card.last4 ?? null,
                type: 'virtual',
                currency: input.currency.toLowerCase(),
                status: 'active',
                spendingLimitMinor: limitMinor,
                spendingInterval: limitMinor != null ? interval : null,
            }),
        );
    }

    listCards(organisationId: string): Promise<IssuingCard[]> {
        return this.cardRepo.find({
            where: { organisationId },
            order: { createdAt: 'DESC' },
        });
    }

    listTransactions(
        organisationId: string,
        filters: { driverId?: string; vehicleId?: string } = {},
    ): Promise<IssuingTransaction[]> {
        const where: Record<string, string> = { organisationId };
        if (filters.driverId) where.driverId = filters.driverId;
        if (filters.vehicleId) where.vehicleId = filters.vehicleId;
        return this.txnRepo.find({
            where,
            order: { createdAt: 'DESC' },
            take: 500,
        });
    }

    /** Freeze ('inactive') or permanently cancel ('canceled') a card. */
    async setCardStatus(
        organisationId: string,
        cardId: string,
        status: 'active' | 'inactive' | 'canceled',
    ): Promise<IssuingCard> {
        const stripeAccount = await this.getStripeAccountId(organisationId);
        const card = await this.cardRepo.findOne({
            where: { id: cardId, organisationId },
        });
        if (!card) throw new NotFoundException('Card not found');

        await this.stripe.issuing.cards.update(
            card.stripeCardId,
            { status },
            { stripeAccount },
        );
        card.status = status;
        return this.cardRepo.save(card);
    }

    /**
     * Mint a short-lived ephemeral key so the client can render full card
     * details with Issuing Elements. The PAN never touches this server.
     */
    async createEphemeralKey(
        organisationId: string,
        cardId: string,
        nonce: string,
        apiVersion: string,
    ): Promise<{ ephemeralKeySecret: string }> {
        const stripeAccount = await this.getStripeAccountId(organisationId);
        const card = await this.cardRepo.findOne({
            where: { id: cardId, organisationId },
        });
        if (!card) throw new NotFoundException('Card not found');

        const key = await this.stripe.ephemeralKeys.create(
            { issuing_card: card.stripeCardId, nonce },
            { apiVersion, stripeAccount },
        );
        if (!key.secret) {
            throw new Error('Stripe did not return an ephemeral key secret');
        }
        return { ephemeralKeySecret: key.secret };
    }

    /**
     * Idempotently record a settled Issuing transaction from the webhook,
     * resolving card -> cardholder -> driver/vehicle. One transaction per
     * Stripe transaction id (unique constraint backs the ON CONFLICT no-op).
     */
    async recordTransaction(txn: StripeIssuingTransaction): Promise<void> {
        const stripeCardId = this.idOf(txn.card);
        if (!stripeCardId) {
            this.logger.warn(`Issuing transaction ${txn.id} has no card — skipped`);
            return;
        }

        const card = await this.cardRepo.findOne({
            where: { stripeCardId },
        });
        if (!card) {
            this.logger.warn(
                `Issuing transaction ${txn.id} references unknown card ${stripeCardId} — skipped`,
            );
            return;
        }

        const cardholder = await this.cardholderRepo.findOne({
            where: { id: card.cardholderId },
        });

        await this.txnRepo
            .createQueryBuilder()
            .insert()
            .into(IssuingTransaction)
            .values({
                organisationId: card.organisationId,
                cardId: card.id,
                cardholderId: card.cardholderId,
                vehicleId: card.vehicleId,
                driverId: cardholder?.driverId ?? null,
                stripeTransactionId: txn.id,
                stripeAuthorizationId: this.idOf(txn.authorization),
                type: txn.type === 'refund' ? 'refund' : 'capture',
                // Issuing reports spend as a negative amount; store the magnitude.
                amountMinor: Math.abs(txn.amount),
                currency: txn.currency,
                merchantName: txn.merchant_data?.name ?? null,
                merchantCategory: txn.merchant_data?.category ?? null,
                merchantCity: txn.merchant_data?.city ?? null,
                merchantCountry: txn.merchant_data?.country ?? null,
                authorizedAt: txn.created
                    ? new Date(txn.created * 1000)
                    : null,
                raw: txn,
            })
            .orIgnore()
            .execute();
    }

    /** Keep the local card status in sync with Stripe (issuing_card.updated). */
    async syncCardStatus(stripeCardId: string, status: string): Promise<void> {
        await this.cardRepo.update({ stripeCardId }, { status });
    }

    private idOf(
        ref: string | { id: string } | null | undefined,
    ): string | null {
        if (!ref) return null;
        return typeof ref === 'string' ? ref : ref.id;
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
