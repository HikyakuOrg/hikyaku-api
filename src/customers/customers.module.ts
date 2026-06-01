import { Module } from '@nestjs/common';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

@Module({
    imports: [OrganisationsModule],
    controllers: [CustomersController],
    providers: [CustomersService],
    exports: [CustomersService],
})
export class CustomersModule {}
