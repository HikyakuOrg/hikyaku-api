import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organisation } from './organisation.entity';
import { OrganisationStripeAccount } from './organisation-stripe-account.entity';
import { OrganisationSubscription } from './organisation-subscription.entity';
import { OrganisationsService } from './organisations.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Organisation,
            OrganisationStripeAccount,
            OrganisationSubscription,
        ]),
    ],
    providers: [OrganisationsService],
    exports: [OrganisationsService],
})
export class OrganisationsModule {}
