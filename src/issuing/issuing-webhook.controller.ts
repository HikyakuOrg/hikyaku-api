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
import { IssuingService } from './issuing.service';
import type { StripeIssuingTransaction } from './issuing.service';

/** See stripe-webhook.controller.ts — `rawBody: true` (main.ts) populates this. */
interface RawBodyRequest {
    rawBody?: Buffer;
}

/**
 * Separate endpoint + signing secret from the payments webhook so the two
 * concerns stay decoupled. Subscribe this endpoint to `issuing.*` events in the
 * Stripe Dashboard / CLI. Unauthenticated by design — trust is the signature.
 */
@Controller('api/v1/stripe')
export class IssuingWebhookController {
    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        private readonly issuing: IssuingService,
    ) {}

    @Post('issuing-webhook')
    @HttpCode(200)
    @ApiExcludeEndpoint()
    async handle(
        @Req() req: RawBodyRequest,
        @Headers('stripe-signature') signature: string,
    ): Promise<{ received: boolean }> {
        const secret = process.env.STRIPE_ISSUING_WEBHOOK_SECRET;
        if (!secret) {
            throw new Error('STRIPE_ISSUING_WEBHOOK_SECRET is not set');
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
        }

        return { received: true };
    }
}
