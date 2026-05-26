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
import { IssuingService } from './issuing.service';
import type { StripeIssuingTransaction } from './issuing.service';

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
 * Connect webhook: now that each org issues on its own connected account, the
 * issuing_* events and account.updated arrive here with `event.account` set to
 * the connected account. Register this endpoint as a **Connect** webhook in the
 * Dashboard / CLI. Unauthenticated by design — trust is the signature.
 */
@Controller('api/v1/stripe')
export class IssuingWebhookController {
    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        private readonly issuing: IssuingService,
        private readonly orgs: OrganisationsService,
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

        switch (event.type) {
            case 'issuing_transaction.created':
                await this.issuing.recordTransaction(
                    event.data.object as unknown as StripeIssuingTransaction,
                );
                break;
            case 'issuing_card.updated': {
                const card = event.data.object as unknown as {
                    id: string;
                    status: string;
                };
                await this.issuing.syncCardStatus(card.id, card.status);
                break;
            }
            case 'account.updated': {
                const account =
                    event.data.object as unknown as StripeConnectAccount;
                const accountId = event.account ?? account.id;
                await this.orgs.updateConnectStatus(accountId, {
                    detailsSubmitted: account.details_submitted ?? false,
                    chargesEnabled: account.charges_enabled ?? false,
                    payoutsEnabled: account.payouts_enabled ?? false,
                    cardIssuingStatus: account.capabilities?.card_issuing ?? null,
                });
                break;
            }
        }

        return { received: true };
    }
}
