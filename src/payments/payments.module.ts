import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceFeesModule } from 'src/service-fees/service-fees.module';
import { Payment } from './entities/payment.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { StripeWebhookController } from './stripe-webhook.controller';

@Module({
    imports: [TypeOrmModule.forFeature([Payment]), ServiceFeesModule],
    controllers: [PaymentsController, StripeWebhookController],
    providers: [PaymentsService],
})
export class PaymentsModule {}
