import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
} from '@nestjs/common';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { OrganisationStripeAccount } from 'src/organisations/organisation-stripe-account.entity';

type AccountCreateParams = Parameters<StripeClient['accounts']['create']>[0];

const ISSUING_ELIGIBLE_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IE', 'NL', 'ES', 'IT'];

/** issuing/funding_instructions isn't a typed SDK resource — call it raw. */
type BankTransferType =
    | 'us_bank_transfer'
    | 'gb_bank_transfer'
    | 'eu_bank_transfer';

export interface ConnectStatus {
    accountId: string | null;
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    cardIssuingStatus: string | null;
    country: string | null;
    currency: string | null;
}

export interface OrgIssuingStatus {
    slug: string;
    cardIssuingStatus: string | null;
    detailsSubmitted: boolean;
}

@Injectable()
export class ConnectService {
    private readonly logger = new Logger(ConnectService.name);

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        private readonly orgs: OrganisationsService,
    ) {}

    /**
     * Create an Account Session for the embedded onboarding component, creating
     * the org's Custom connected account on first call. Returns the session
     * client_secret and the platform publishable key the frontend needs to
     * initialise @stripe/connect-js.
     */
    async createAccountSession(
        organisationId: string,
        country: string,
    ): Promise<{ clientSecret: string; publishableKey: string }> {
        const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
        if (!publishableKey) {
            throw new Error('STRIPE_PUBLISHABLE_KEY is not set');
        }

        await this.orgs.getOrFail(organisationId);
        const accountId = await this.ensureAccount(organisationId, country);

        const session = await this.stripe.accountSessions.create({
            account: accountId,
            components: {
                account_onboarding: { enabled: true },
            },
        });

        return { clientSecret: session.client_secret, publishableKey };
    }

    /**
     * Create the connected account if the org doesn't have one yet. Custom
     * account: no Stripe dashboard, platform collects requirements and holds
     * loss liability — the only model Issuing on Connect supports without
     * Stripe approval. Only card_payments + transfers are requested here;
     * card_issuing is requested later (see maybeRequestCardIssuing).
     */
    private async ensureAccount(
        organisationId: string,
        country: string,
    ): Promise<string> {
        const stripe = await this.orgs.getStripeAccount(organisationId);
        if (stripe?.stripeAccountId) return stripe.stripeAccountId;

        const countryUpper = country.toUpperCase();

        const params: AccountCreateParams = {
            country: countryUpper,

            controller: {
                stripe_dashboard: { type: 'none' },
                requirement_collection: 'application',
                losses: { payments: 'application' },
                fees: { payer: 'application' },
            },
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
            metadata: { organisationId },
        };

        const account = await this.stripe.accounts.create(params);

        await this.orgs.setStripeAccount(organisationId, account.id);
        this.logger.log(
            `Created connected account ${account.id} for org ${organisationId} (country=${countryUpper})`,
        );

        return account.id;
    }

    /**
     * Request the card_issuing capability once the org has finished base
     * onboarding (details_submitted). Driven by the account.updated webhook —
     * deliberately NOT at account-creation time: Stripe rejects card_issuing on
     * a brand-new account that has no verified details yet. Idempotent: once
     * requested, the capability status from Stripe is non-null so we skip.
     */
    async maybeRequestCardIssuing(stripeAccountId: string): Promise<void> {
        const stripe = await this.orgs.findByStripeAccountId(stripeAccountId);
        if (!stripe?.stripeAccountId) return;

        const account = await this.stripe.accounts.retrieve(stripeAccountId);
        if (!account.details_submitted) return;
        if (account.capabilities?.card_issuing != null) return;

        const country = (account.country ?? '').toUpperCase();
        if (!ISSUING_ELIGIBLE_COUNTRIES.includes(country)) return;

        try {
            await this.stripe.accounts.update(stripe.stripeAccountId, {
                capabilities: { card_issuing: { requested: true } },
            });
            this.logger.log(
                `Requested card_issuing for ${stripe.stripeAccountId} after onboarding`,
            );
        } catch (err) {
            // Never fail the webhook. If the platform isn't approved for Issuing
            // it surfaces here and self-heals on the next account.updated event.
            this.logger.error(
                `Failed to request card_issuing for ${stripe.stripeAccountId}: ${String(err)}`,
            );
        }
    }

    async getStatus(organisationId: string): Promise<ConnectStatus> {
        await this.orgs.getOrFail(organisationId);
        const stripeAccount = await this.orgs.getStripeAccount(organisationId);
        if (!stripeAccount?.stripeAccountId) {
            return {
                accountId: null,
                detailsSubmitted: false,
                chargesEnabled: false,
                payoutsEnabled: false,
                cardIssuingStatus: null,
                country: null,
                currency: null,
            };
        }
        const account = await this.stripe.accounts.retrieve(stripeAccount.stripeAccountId);
        return {
            accountId: stripeAccount.stripeAccountId,
            detailsSubmitted: account.details_submitted ?? false,
            chargesEnabled: account.charges_enabled ?? false,
            payoutsEnabled: account.payouts_enabled ?? false,
            cardIssuingStatus: account.capabilities?.card_issuing ?? null,
            country: account.country ?? null,
            currency: account.default_currency ?? null,
        };
    }

    /** Issuing-status flags for all orgs the user belongs to — powers the org switcher. */
    async getAllIssuingStatuses(userId: string): Promise<OrgIssuingStatus[]> {
        const accounts = await this.orgs.getAccountsForUser(userId);
        return Promise.all(
            accounts.map(async ({ slug, stripeAccountId }) => {
                if (!stripeAccountId) {
                    return { slug, cardIssuingStatus: null, detailsSubmitted: false };
                }
                const account = await this.stripe.accounts.retrieve(stripeAccountId);
                return {
                    slug,
                    cardIssuingStatus: account.capabilities?.card_issuing ?? null,
                    detailsSubmitted: account.details_submitted ?? false,
                };
            }),
        );
    }

    /**
     * Push funding instructions: bank coordinates the org wires its own money to
     * in order to top up its Issuing balance. The org self-funds, so the org's
     * money is at risk for card spend — not the platform's.
     */
    async getFundingInstructions(organisationId: string): Promise<unknown> {
        const stripe = await this.requireOnboardedAccount(organisationId);
        const account = await this.stripe.accounts.retrieve(stripe.stripeAccountId as string);
        const currency = (account.default_currency ?? 'usd').toLowerCase();

        return this.stripe.rawRequest(
            'POST',
            '/v1/issuing/funding_instructions',
            {
                currency,
                funding_type: 'bank_transfer',
                bank_transfer: { type: this.bankTransferType(currency) },
            },
            { stripeAccount: stripe.stripeAccountId as string },
        );
    }

    /** Current Issuing balance on the connected account (available to spend). */
    async getIssuingBalance(
        organisationId: string,
    ): Promise<{ amount: number; currency: string }[]> {
        const stripe = await this.requireOnboardedAccount(organisationId);
        const balance = await this.stripe.balance.retrieve(
            {},
            { stripeAccount: stripe.stripeAccountId as string },
        );
        return (balance.issuing?.available ?? []).map((b) => ({
            amount: b.amount,
            currency: b.currency,
        }));
    }

    private async requireOnboardedAccount(
        organisationId: string,
    ): Promise<OrganisationStripeAccount> {
        await this.orgs.getOrFail(organisationId);
        const stripe = await this.orgs.getStripeAccount(organisationId);
        if (!stripe?.stripeAccountId) {
            throw new BadRequestException(
                'No Stripe account yet. Complete organisation onboarding first.',
            );
        }
        return stripe;
    }

    private bankTransferType(currency: string): BankTransferType {
        switch (currency) {
            case 'usd':
                return 'us_bank_transfer';
            case 'gbp':
                return 'gb_bank_transfer';
            case 'eur':
                return 'eu_bank_transfer';
            default:
                throw new BadRequestException(
                    `Self-funding is not supported for currency "${currency}".`,
                );
        }
    }
}
