import { Module } from '@nestjs/common';
import { CustomersModule } from 'src/customers/customers.module';
import { DispatchModule } from 'src/dispatch/dispatch.module';
import { GeocodeModule } from 'src/geocode/geocode.module';
import { PackagesModule } from 'src/packages/packages.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { OrderEventProcessor } from './order-event.processor';
import { OrderEventWorker } from './order-event.worker';
import { OrderGeocoder } from './order-geocoder';

/**
 * Storefront orders in, packages out. The controller only records; the
 * worker, woken by a NOTIFY on insert (PgNotifyService, from DispatchModule),
 * geocodes, upserts the customer and creates and assigns the package.
 */
@Module({
    imports: [CustomersModule, DispatchModule, GeocodeModule, PackagesModule],
    controllers: [IntegrationsController],
    providers: [
        IntegrationsService,
        OrderGeocoder,
        OrderEventProcessor,
        OrderEventWorker,
    ],
})
export class IntegrationsModule {}
