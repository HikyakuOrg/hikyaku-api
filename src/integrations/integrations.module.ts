import { Module } from '@nestjs/common';
import { CustomersModule } from 'src/customers/customers.module';
import { DispatchModule } from 'src/dispatch/dispatch.module';
import { GeocodeModule } from 'src/geocode/geocode.module';
import { OrganisationsModule } from 'src/organisations/organisations.module';
import { PackagesModule } from 'src/packages/packages.module';
import { ServicesModule } from 'src/services/services.module';
import { ValhallaModule } from 'src/valhalla/valhalla.module';
import { CarrierRatesService } from './carrier-rates/carrier-rates.service';
import { ShopifyCarrierRatesController } from './carrier-rates/shopify-carrier-rates.controller';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { LocationMappingsController } from './location-mappings.controller';
import { LocationMappingsService } from './location-mappings.service';
import { OrderEventProcessor } from './order-event.processor';
import { OrderEventWorker } from './order-event.worker';
import { OrderGeocoder } from './order-geocoder';
import { ShippingRateSettingsController } from './shipping-rate-settings.controller';
import { ShippingRateSettingsService } from './shipping-rate-settings.service';
import { StaticRatesController } from './static-rates/static-rates.controller';
import { StaticRatesPushService } from './static-rates/static-rates-push.service';
import { StaticRatesService } from './static-rates/static-rates.service';

/**
 * Storefront orders in, packages out. IntegrationsController records events.
 * OrderEventWorker, woken by NOTIFY (PgNotifyService from DispatchModule),
 * turns them into packages. LocationMappingsController maps storefront
 * locations to warehouses. ShippingRateSettingsController stores which
 * services each shop offers as checkout rates, and
 * ShopifyCarrierRatesController prices them at checkout. For shops that
 * can't call back, StaticRatesController serves fixed rates and coverage, and
 * StaticRatesPushService tells the app when to fetch them again.
 */
@Module({
    imports: [
        CustomersModule,
        DispatchModule,
        GeocodeModule,
        OrganisationsModule,
        PackagesModule,
        ServicesModule,
        ValhallaModule,
    ],
    controllers: [
        IntegrationsController,
        LocationMappingsController,
        ShippingRateSettingsController,
        ShopifyCarrierRatesController,
        StaticRatesController,
    ],
    providers: [
        CarrierRatesService,
        IntegrationsService,
        LocationMappingsService,
        OrderGeocoder,
        OrderEventProcessor,
        OrderEventWorker,
        ShippingRateSettingsService,
        StaticRatesPushService,
        StaticRatesService,
    ],
})
export class IntegrationsModule {}
