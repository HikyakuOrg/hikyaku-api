import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { ValhallaModule } from 'src/valhalla/valhalla.module';
import { Payment } from 'src/payments/entities/payment.entity';
import { ServicesService } from './services.service';
import { BookingService } from './booking.service';
import { ServicesController } from './services.controller';
import { ServicesPublicController } from './services-public.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([Payment]),
        OrganisationsModule,
        ValhallaModule,
    ],
    controllers: [ServicesController, ServicesPublicController],
    providers: [ServicesService, BookingService],
    exports: [ServicesService],
})
export class ServicesModule {}
