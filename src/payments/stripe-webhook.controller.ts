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
import { BillingService } from 'src/billing/billing.service';
import type {
    CustomerEventPayload,
    EntitlementSummaryEventPayload,
    SubscriptionEventPayload,
} from 'src/billing/billing.service';
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
        private readonly billingService: BillingService,
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

        // Keeps organisations.trial_ends_at/subscription_status — the cache
        // PermissionGuard and BillingService.getTrialStatus both read — in sync
        // with Stripe for every status transition after
        // BillingService.ensureSubscription() creates the subscription
        // (trialing -> canceled at trial end, or -> active once a payment
        // method exists). `created` is included so this self-heals even if the
        // synchronous write in ensureSubscription() failed after Stripe's API
        // call succeeded.
        if (
            event.type === 'customer.subscription.created' ||
            event.type === 'customer.subscription.updated' ||
            event.type === 'customer.subscription.deleted'
        ) {
            const subscription =
                event.data.object as unknown as SubscriptionEventPayload;
            await this.billingService.syncSubscriptionFromStripe(subscription);
        }

        // Keeps stripe.organisation_subscriptions.has_payment_method — the
        // column enforce_shift_allowance() reads to decide whether an org past
        // its free shift allowance is blocked or billed as overage — in sync
        // with whether the org's Stripe customer actually has a default payment
        // method. Fires whenever a customer is created, updated, or attaches one
        // via the Billing Portal (BillingService.createBillingPortalSession).
        if (event.type === 'customer.updated') {
            const customer = event.data.object as unknown as CustomerEventPayload;
            await this.billingService.syncPaymentMethodFromStripe(customer);
        }

        // Keeps stripe.organisation_subscriptions.has_vanity_url_entitlement
        // — the column get_booking_organisation()/get_tracking_details() read
        // to decide whether a company org's vanity_slug host currently
        // resolves — in sync with the customer's live vanity_url entitlement.
        // Fires whenever an entitlement is granted or revoked (e.g. the
        // subscription is canceled and the Organisation plan's features fall
        // away).
        if (event.type === 'entitlements.active_entitlement_summary.updated') {
            const summary =
                event.data.object as unknown as EntitlementSummaryEventPayload;
            await this.billingService.syncVanityUrlEntitlementFromStripe(summary);
        }

        return { received: true };
    }
}
