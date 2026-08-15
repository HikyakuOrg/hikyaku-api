import { Module } from '@nestjs/common';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * Subscription and trial state. Owns no tables of its own — the trial deadline is
 * a column on `organisations` — so it reads through OrganisationsService rather
 * than registering an entity.
 *
 * It exists as its own module rather than a controller bolted onto
 * OrganisationsModule because this is where Stripe subscriptions, checkout, and
 * the customer portal will land; keeping organisations a pure data-owner keeps
 * that growth out of it.
 */
@Module({
    imports: [OrganisationsModule],
    controllers: [BillingController],
    providers: [BillingService],
    exports: [BillingService],
})
export class BillingModule {}
