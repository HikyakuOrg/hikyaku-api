import { Module } from '@nestjs/common';
import { CustomersModule } from 'src/customers/customers.module';
import { DispatchModule } from 'src/dispatch/dispatch.module';
import { GeocodeModule } from 'src/geocode/geocode.module';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { PackagesModule } from 'src/packages/packages.module';
import { ServicesModule } from 'src/services/services.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { LocationMappingsController } from './location-mappings.controller';
import { LocationMappingsService } from './location-mappings.service';
import { OrderEventProcessor } from './order-event.processor';
import { OrderEventWorker } from './order-event.worker';
import { OrderGeocoder } from './order-geocoder';
import { ShippingRateSettingsController } from './shipping-rate-settings.controller';
import { ShippingRateSettingsService } from './shipping-rate-settings.service';

/**
 * Storefront orders in, packages out. IntegrationsController records events.
 * OrderEventWorker, woken by NOTIFY (PgNotifyService from DispatchModule),
 * turns them into packages. LocationMappingsController maps storefront
 * locations to warehouses. ShippingRateSettingsController stores which
 * services each shop offers as checkout rates.
 */
@Module({
    imports: [
        CustomersModule,
        DispatchModule,
        GeocodeModule,
        OrganisationsModule,
        PackagesModule,
        ServicesModule,
    ],
    controllers: [
        IntegrationsController,
        LocationMappingsController,
        ShippingRateSettingsController,
    ],
    providers: [
        IntegrationsService,
        LocationMappingsService,
        OrderGeocoder,
        OrderEventProcessor,
        OrderEventWorker,
        ShippingRateSettingsService,
    ],
})
export class IntegrationsModule {}
