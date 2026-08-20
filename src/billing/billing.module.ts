import { Module } from '@nestjs/common';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * Subscription and trial state. Owns no tables of its own — the trial deadline
 * and the Stripe customer/subscription satellite row are columns on
 * `organisations` / `stripe.organisation_subscriptions` — so it reads and
 * writes through OrganisationsService rather than registering its own entity.
 *
 * It exists as its own module rather than a controller bolted onto
 * OrganisationsModule because this is where Stripe subscription provisioning
 * (BillingService.ensureSubscription), checkout, and the customer portal land;
 * keeping organisations a pure data-owner keeps that growth out of it.
 */
@Module({
    imports: [OrganisationsModule],
    controllers: [BillingController],
    providers: [BillingService],
    exports: [BillingService],
})
export class BillingModule {}
