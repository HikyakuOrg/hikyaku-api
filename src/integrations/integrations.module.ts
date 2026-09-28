import { Module } from '@nestjs/common';
import { CustomersModule } from 'src/customers/customers.module';
import { DispatchModule } from 'src/dispatch/dispatch.module';
import { GeocodeModule } from 'src/geocode/geocode.module';
import { PackagesModule } from 'src/packages/packages.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { LocationMappingsController } from './location-mappings.controller';
import { LocationMappingsService } from './location-mappings.service';
import { OrderEventProcessor } from './order-event.processor';
import { OrderEventWorker } from './order-event.worker';
import { OrderGeocoder } from './order-geocoder';

/**
 * Storefront orders in, packages out. IntegrationsController records events.
 * OrderEventWorker, woken by NOTIFY (PgNotifyService from DispatchModule),
 * turns them into packages. LocationMappingsController maps storefront
 * locations to warehouses.
 */
@Module({
    imports: [CustomersModule, DispatchModule, GeocodeModule, PackagesModule],
    controllers: [IntegrationsController, LocationMappingsController],
    providers: [
        IntegrationsService,
        LocationMappingsService,
        OrderGeocoder,
        OrderEventProcessor,
        OrderEventWorker,
    ],
})
export class IntegrationsModule {}
