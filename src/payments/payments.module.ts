import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomersModule } from 'src/customers/customers.module';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { StripeWebhookController } from './stripe-webhook.controller';

// Checkout creation moved to the Services module with the unit-priced catalog
// remodel. This module now only owns webhook-driven fulfillment.
@Module({
    imports: [TypeOrmModule.forFeature([Payment]), CustomersModule],
    controllers: [StripeWebhookController],
    providers: [PaymentsService],
})
export class PaymentsModule {}
