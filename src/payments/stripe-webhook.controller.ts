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
import { PaymentsService } from './payments.service';
import type { FulfillableCheckoutSession } from './payments.service';

/**
 * Minimal shape of what we need off the request. Declared locally (not imported)
 * so it is safe to reference in a decorated parameter under `isolatedModules` +
 * `emitDecoratorMetadata`. Nest sets `rawBody` because `rawBody: true` is passed
 * to NestFactory in main.ts.
 */
interface RawBodyRequest {
    rawBody?: Buffer;
}

@Controller('api/v1/stripe')
export class StripeWebhookController {
    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        private readonly paymentsService: PaymentsService,
    ) {}

    /**
     * Unauthenticated by design — trust is established by Stripe's signature,
     * not by our AuthGuard. Reads the raw body (enabled via `rawBody: true` in
     * main.ts) because signature verification needs the exact bytes.
     */
    @Post('webhook')
    @HttpCode(200)
    @ApiExcludeEndpoint()
    async handle(
        @Req() req: RawBodyRequest,
        @Headers('stripe-signature') signature: string,
    ): Promise<{ received: boolean }> {
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret) {
            throw new Error('STRIPE_WEBHOOK_SECRET is not set');
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

        // Catalog payments are DIRECT charges on the org's connected account, so
        // the completion event is delivered with `event.account` set — this
        // endpoint MUST be subscribed to connected-account events in the Stripe
        // dashboard (R1) or it simply won't fire. The handler keys off the session
        // id, so no code change is needed for `event.account`.
        //
        // We omit `payment_method_types` (dynamic methods), so a delayed/async
        // method can settle later: fulfil on async_payment_succeeded too. The
        // failure/expiry events are deliberately ignored — fulfillment is gated on
        // `payment_status === 'paid'`, so a non-successful payment creates nothing.
        if (
            event.type === 'checkout.session.completed' ||
            event.type === 'checkout.session.async_payment_succeeded'
        ) {
            const session =
                event.data.object as unknown as FulfillableCheckoutSession;
            if (session.payment_status === 'paid') {
                await this.paymentsService.fulfillCheckoutSession(session);
            }
        }

        return { received: true };
    }
}
