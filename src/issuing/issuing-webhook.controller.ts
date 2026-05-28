import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    Inject,
    Post,
    Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ConnectService } from 'src/connect/connect.service';

/** See stripe-webhook.controller.ts — `rawBody: true` (main.ts) populates this. */
interface RawBodyRequest {
    rawBody?: Buffer;
}

/** Minimal shape of a Connect Account off the account.updated event. */
interface StripeConnectAccount {
    id: string;
    details_submitted?: boolean | null;
    charges_enabled?: boolean | null;
    payouts_enabled?: boolean | null;
    capabilities?: { card_issuing?: string | null } | null;
}

/**
 * Connect webhook. Issuing cards/transactions are now fetched on demand from
 * Stripe (no local DB), so `issuing_transaction.created` and `issuing_card.updated`
 * are intentionally ignored — Stripe still sends them; we just no-op (200).
 * `account.updated` is the one event we still care about: it keeps the
 * organisation's Connect capability state in sync. Register this endpoint as a
 * **Connect** webhook in the Dashboard / CLI. Unauthenticated by design — trust
 * is the signature.
 */
@Controller('api/v1/stripe')
export class IssuingWebhookController {
    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        private readonly orgs: OrganisationsService,
        private readonly connect: ConnectService,
    ) {}

    @Post('issuing-webhook')
    @HttpCode(200)
    @ApiExcludeEndpoint()
    async handle(
        @Req() req: RawBodyRequest,
        @Headers('stripe-signature') signature: string,
    ): Promise<{ received: boolean }> {
        const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
        if (!secret) {
            throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not set');
        }
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw request body');
        }

        let event: ReturnType<StripeClient['webhooks']['constructEvent']>;
        try {
            event = this.stripe.webhooks.constructEvent(
                req.rawBody,
                signature,
                secret,
            );
        } catch (err) {
            throw new BadRequestException(
                `Webhook signature verification failed: ${String(err)}`,
            );
        }

        if (event.type === 'account.updated') {
            const account = event.data.object as unknown as StripeConnectAccount;
            const accountId = event.account ?? account.id;
            await this.orgs.updateConnectStatus(accountId, {
                detailsSubmitted: account.details_submitted ?? false,
                chargesEnabled: account.charges_enabled ?? false,
                payoutsEnabled: account.payouts_enabled ?? false,
                cardIssuingStatus: account.capabilities?.card_issuing ?? null,
            });
            // Now that base onboarding state is persisted, request card_issuing
            // if onboarding is complete and it hasn't been requested yet.
            await this.connect.maybeRequestCardIssuing(accountId);
        }

        return { received: true };
    }
}
