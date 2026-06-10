import { Module } from '@nestjs/common';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { ValhallaModule } from 'src/valhalla/valhalla.module';
import { RoutingController } from './routing.controller';

@Module({
    imports: [OrganisationsModule, ValhallaModule],
    controllers: [RoutingController],
})
export class RoutingModule {}
