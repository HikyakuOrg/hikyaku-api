import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from 'src/customers/customers.module';
import { BillingModule } from 'src/billing/billing.module';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { StripeWebhookController } from './stripe-webhook.controller';

// Checkout creation moved to the Services module with the unit-priced catalog
// remodel. This module now only owns webhook-driven fulfillment — for both
// Checkout Sessions (PaymentsService) and, as of BillingModule, subscription
// lifecycle events (BillingService.syncSubscriptionFromStripe). One endpoint,
// one signing secret, so a new event type is a new `if` here rather than a new
// webhook to register in the Stripe dashboard.
@Module({
    imports: [TypeOrmModule.forFeature([Payment]), CustomersModule, BillingModule],
    controllers: [StripeWebhookController],
    providers: [PaymentsService],
})
export class PaymentsModule {}
