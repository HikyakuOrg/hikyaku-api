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
        currency: string,
    ): Promise<{ clientSecret: string; publishableKey: string }> {
        const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
        if (!publishableKey) {
            throw new Error('STRIPE_PUBLISHABLE_KEY is not set');
        }

        const org = await this.orgs.getOrFail(organisationId);
        const accountId = await this.ensureAccount(org, country, currency);

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
     * Stripe approval. card_issuing + transfers capabilities are requested.
     */
    private async ensureAccount(
        org: Organisation,
        country: string,
        currency: string,
    ): Promise<string> {
        if (org.stripeAccountId) return org.stripeAccountId;

        await this.assertPlatformIssuingEnabled();

        const params: AccountCreateParams = {
            country: country.toUpperCase(),
            controller: {
                stripe_dashboard: { type: 'none' },
                requirement_collection: 'stripe',
                losses: { payments: 'stripe' },
                fees: { payer: 'account' },
            },
            capabilities: {
               card_issuing: { requested: true },
               transfers: { requested: true },
            },
            metadata: { organisationId: org.id },
        };

        const account = await this.stripe.accounts.create(params);
        await this.orgs.setStripeAccount(
            org.id,
            account.id,
            country.toUpperCase(),
            currency.toLowerCase(),
        );
        this.logger.log(
            `Created connected account ${account.id} for org ${org.id}`,
        );
        return account.id;
    }

    /**
     * card_issuing can only be requested on a connected account once the
     * platform itself is onboarded on Stripe Issuing. Surface a clear,
     * actionable error rather than Stripe's opaque "...already" message.
     */
    private async assertPlatformIssuingEnabled(): Promise<void> {
        // null id = the account the API key belongs to (GET /v1/account).
        const platform = await this.stripe.accounts.retrieve(null);
        if (platform.capabilities?.card_issuing !== 'active') {
            throw new BadRequestException(
                'Stripe Issuing is not activated on the platform account yet. ' +
                    'Activate Issuing in the Stripe Dashboard (Issuing → Activate) before onboarding organisations.',
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
                'No Stripe account yet. Set up payments in Settings → Payments first.',
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
