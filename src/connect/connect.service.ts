import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
} from '@nestjs/common';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { Organisation } from 'src/organisations/organisation.entity';

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

        const org = await this.orgs.getOrFail(organisationId);
        const accountId = await this.ensureAccount(org, country);

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
        org: Organisation,
        country: string,
    ): Promise<string> {
        if (org.stripeAccountId) return org.stripeAccountId;

        const countryUpper = country.toUpperCase();

        const params: AccountCreateParams = {
            country: countryUpper,
            controller: {
                stripe_dashboard: { type: 'none' },
                requirement_collection: 'stripe',
                losses: { payments: 'stripe' },
                fees: { payer: 'account' },
            },
            capabilities: {
                card_payments: { requested: true },
                transfers: { requested: true },
            },
            metadata: { organisationId: org.id },
        };

        const account = await this.stripe.accounts.create(params);
        const currency = (account.default_currency ?? 'usd').toLowerCase();

        await this.orgs.setStripeAccount(
            org.id,
            account.id,
            countryUpper,
            currency,
        );
        this.logger.log(
            `Created connected account ${account.id} for org ${org.id} (country=${countryUpper})`,
        );

        return account.id;
    }

    /**
     * Request the card_issuing capability once the org has finished base
     * onboarding (details_submitted). Driven by the account.updated webhook —
     * deliberately NOT at account-creation time: Stripe rejects card_issuing on
     * a brand-new account that has no verified details yet. Idempotent: once
     * requested, the capability mirror (cardIssuingStatus) is non-null so we skip.
     */
    async maybeRequestCardIssuing(stripeAccountId: string): Promise<void> {
        const org = await this.orgs.findByStripeAccountId(stripeAccountId);
        if (!org?.stripeAccountId) return;
        if (!org.detailsSubmitted) return;
        if (org.cardIssuingStatus != null) return;

        const country = (org.stripeAccountCountry ?? '').toUpperCase();
        if (!ISSUING_ELIGIBLE_COUNTRIES.includes(country)) return;

        try {
            await this.stripe.accounts.update(org.stripeAccountId, {
                capabilities: { card_issuing: { requested: true } },
            });
            this.logger.log(
                `Requested card_issuing for ${org.stripeAccountId} after onboarding`,
            );
        } catch (err) {
            // Never fail the webhook. If the platform isn't approved for Issuing
            // it surfaces here and self-heals on the next account.updated event.
            this.logger.error(
                `Failed to request card_issuing for ${org.stripeAccountId}: ${String(err)}`,
            );
        }
    }

    async getStatus(organisationId: string): Promise<ConnectStatus> {
        const org = await this.orgs.getOrFail(organisationId);
        return {
            accountId: org.stripeAccountId,
            detailsSubmitted: org.detailsSubmitted,
            chargesEnabled: org.chargesEnabled,
            payoutsEnabled: org.payoutsEnabled,
            cardIssuingStatus: org.cardIssuingStatus,
            country: org.stripeAccountCountry,
            currency: org.stripeDefaultCurrency,
        };
    }

    /**
     * Push funding instructions: bank coordinates the org wires its own money to
     * in order to top up its Issuing balance. The org self-funds, so the org's
     * money is at risk for card spend — not the platform's.
     */
    async getFundingInstructions(organisationId: string): Promise<unknown> {
        const org = await this.requireOnboardedAccount(organisationId);
        const currency = (org.stripeDefaultCurrency ?? 'usd').toLowerCase();

        return this.stripe.rawRequest(
            'POST',
            '/v1/issuing/funding_instructions',
            {
                currency,
                funding_type: 'bank_transfer',
                bank_transfer: { type: this.bankTransferType(currency) },
            },
            { stripeAccount: org.stripeAccountId as string },
        );
    }

    /** Current Issuing balance on the connected account (available to spend). */
    async getIssuingBalance(
        organisationId: string,
    ): Promise<{ amount: number; currency: string }[]> {
        const org = await this.requireOnboardedAccount(organisationId);
        const balance = await this.stripe.balance.retrieve(
            {},
            { stripeAccount: org.stripeAccountId as string },
        );
        return (balance.issuing?.available ?? []).map((b) => ({
            amount: b.amount,
            currency: b.currency,
        }));
    }

    private async requireOnboardedAccount(
        organisationId: string,
    ): Promise<Organisation> {
        const org = await this.orgs.getOrFail(organisationId);
        if (!org.stripeAccountId) {
            throw new BadRequestException(
                'No Stripe account yet. Complete organisation onboarding first.',
            );
        }
        return org;
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
