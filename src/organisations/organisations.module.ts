import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Organisation } from './organisation.entity';
import { OrganisationStripeAccount } from './organisation-stripe-account.entity';
import { OrganisationsService } from './organisations.service';

@Module({
    imports: [TypeOrmModule.forFeature([Organisation, OrganisationStripeAccount])],
    providers: [OrganisationsService],
    exports: [OrganisationsService],
})
export class OrganisationsModule {}
