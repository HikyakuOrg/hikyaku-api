import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    allDriversAsFloatersForPoint,
    coveringDriversForPoint,
    isPlausibleLonLat,
} from 'src/dispatch/coverage';
import { resolveDispatchSettings } from 'src/dispatch/dispatch-settings';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ServicesService } from 'src/services/services.service';
import type { CatalogProduct } from 'src/services/services.service';
import { ValhallaService } from 'src/valhalla/valhalla.service';
import { LocationMappingsService } from '../location-mappings.service';
import { OrderGeocoder, UngeocodableAddressError } from '../order-geocoder';
import { ShippingRateSettingsService } from '../shipping-rate-settings.service';
import {
    buildRates,
    cartGrams,
    needsDistance,
    priceableServices,
    warehouseForOrigin,
    type CarrierRateAddress,
    type CarrierRateRequest,
    type CarrierRateResponse,
} from './carrier-rates';

/**
 * The default budget for the whole callback. Shopify allows 10 s under 1,500
 * requests a minute per shop and 5 s or 3 s above that, and shows backup
 * rates on a timeout. CARRIER_RATE_BUDGET_MS overrides it.
 */
export const CARRIER_RATE_BUDGET_MS = 4_000;

/**
 * Photon's own timeout. Longer than the budget on purpose: a cold address
 * can take Photon several seconds, and a lookup that outlives its request
 * still lands in the geocode cache, so Shopify's next callback for the same
 * cart (it calls again as the shopper edits checkout) gets a rate.
 */
const GEOCODE_TIMEOUT_MS = 20_000;

/** How long a geocoded destination is reused, and a failed one refused. */
const GEOCODE_TTL_MS = 60 * 60_000;
const GEOCODE_MISS_TTL_MS = 10 * 60_000;
const GEOCODE_CACHE_MAX = 5_000;

/** How long a connected account's catalog is reused between checkouts. */
const CATALOG_TTL_MS = 60_000;

function budgetMs(): number {
    const fromEnv = Number(process.env.CARRIER_RATE_BUDGET_MS);
    return Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : CARRIER_RATE_BUDGET_MS;
}

const PLATFORM = 'shopify';

/** Why a request got no rates. Logged, never shown to the shopper. */
class NoRates extends Error {}

/**
 * Prices a Shopify carrier rate request: settings → origin warehouse →
 * geocoded destination → coverage (the same call dispatch makes) → one rate
 * per chosen service. Every miss and every failure answers `{ rates: [] }`,
 * so checkout falls back to the store's other rates; it never throws.
 */
@Injectable()
export class CarrierRatesService {
    private readonly logger = new Logger(CarrierRatesService.name);
    private readonly catalogCache = new Map<
        string,
        { at: number; map: Map<string, CatalogProduct> }
    >();
    /** Destination address key → its lookup, in flight or settled. */
    private readonly geocodeCache = new Map<
        string,
        {
            at: number;
            ttl: number;
            point: Promise<{ lon: number; lat: number }>;
        }
    >();

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly settings: ShippingRateSettingsService,
        private readonly locations: LocationMappingsService,
        private readonly geocoder: OrderGeocoder,
        private readonly valhalla: ValhallaService,
        private readonly orgs: OrganisationsService,
        private readonly services: ServicesService,
    ) {}

    async rates(
        shopDomain: string,
        request: CarrierRateRequest,
    ): Promise<CarrierRateResponse> {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('carrier rate budget exceeded')),
                budgetMs(),
            );
        });
        try {
            return await Promise.race([
                this.price(shopDomain, request),
                deadline,
            ]);
        } catch (err) {
            if (err instanceof NoRates) {
                this.logger.debug(`No rates for ${shopDomain}: ${err.message}`);
            } else {
                this.logger.warn(
                    `Carrier rates failed for ${shopDomain}: ${String(err)}`,
                );
            }
            return { rates: [] };
        } finally {
            clearTimeout(timer);
        }
    }

    private async price(
        shopDomain: string,
        request: CarrierRateRequest,
    ): Promise<CarrierRateResponse> {
        const rate = request.rate;
        if (!rate) throw new NoRates('no rate in body');

        const settings = await this.settings.findByShop(PLATFORM, shopDomain);
        if (!settings?.enabled || !settings.shop_currency) {
            return { rates: [] };
        }
        const currency = settings.shop_currency.toUpperCase();
        if ((rate.currency ?? '').toUpperCase() !== currency) {
            throw new NoRates(
                `request currency ${rate.currency} is not the shop currency ${currency}`,
            );
        }
        const organisationId = settings.organisation_id;

        // Independent lookups, in parallel to save the budget.
        const [candidates, catalog, destination] = await Promise.all([
            this.locations.originCandidates(
                organisationId,
                PLATFORM,
                shopDomain,
            ),
            this.catalog(organisationId),
            this.geocode(rate.destination),
        ]);

        const warehouseId = warehouseForOrigin(rate.origin, candidates);
        if (!warehouseId)
            throw new NoRates('origin matches no mapped location');

        const services = priceableServices(
            settings.service_ids,
            catalog,
            currency,
        );
        if (services.length === 0) throw new NoRates('no priceable service');

        const [warehouse, covered] = await Promise.all([
            this.warehousePoint(organisationId, warehouseId),
            this.covered(organisationId, warehouseId, destination),
        ]);
        if (!covered) throw new NoRates('no driver covers the destination');

        const distanceKm = needsDistance(services)
            ? await this.valhalla.routeDistanceKm([
                  [warehouse.lon, warehouse.lat],
                  [destination.lon, destination.lat],
              ])
            : 0;
        if (!Number.isFinite(distanceKm)) {
            throw new Error('Valhalla returned no distance');
        }

        return {
            rates: buildRates(
                services,
                { distanceKm, weightKg: cartGrams(rate.items) / 1000 },
                currency,
            ),
        };
    }

    /**
     * The destination's point, from the cache when this address was looked
     * up recently. A lookup is cached the moment it starts, so one that
     * outlives this request still serves the next callback for the cart.
     */
    private geocode(
        destination: CarrierRateAddress | undefined,
    ): Promise<{ lon: number; lat: number }> {
        if (!destination?.address1) {
            return Promise.reject(new NoRates('no destination street'));
        }
        const key = [
            destination.country,
            destination.postal_code,
            destination.province,
            destination.city,
            destination.address1,
            destination.address2,
        ]
            .map((part) => (part ?? '').trim().toLowerCase())
            .join('|');

        const now = Date.now();
        const cached = this.geocodeCache.get(key);
        if (cached && now - cached.at < cached.ttl) return cached.point;

        const entry = {
            at: now,
            ttl: GEOCODE_TTL_MS,
            point: this.geocoder
                .geocodeAddress(
                    {
                        line1: destination.address1,
                        line2: destination.address2 ?? null,
                        city: destination.city ?? null,
                        province: destination.province ?? null,
                        province_code: destination.province ?? null,
                        postcode: destination.postal_code ?? null,
                        country: destination.country ?? null,
                        country_code: destination.country ?? null,
                        company: destination.company_name ?? null,
                    },
                    GEOCODE_TIMEOUT_MS,
                )
                .then(({ lon, lat }) => ({ lon, lat }))
                .catch((err: unknown) => {
                    // An address Photon can't place stays refused for a
                    // while; a transient failure is retried next time.
                    if (err instanceof UngeocodableAddressError) {
                        entry.ttl = GEOCODE_MISS_TTL_MS;
                    } else {
                        this.geocodeCache.delete(key);
                    }
                    throw new NoRates(
                        `destination not geocoded: ${String(err)}`,
                    );
                }),
        };
        // An unawaited rejection must not crash the process when the
        // request that started the lookup has already answered.
        entry.point.catch(() => undefined);

        if (this.geocodeCache.size >= GEOCODE_CACHE_MAX) {
            // Maps iterate in insertion order: drop the oldest.
            for (const oldest of this.geocodeCache.keys()) {
                this.geocodeCache.delete(oldest);
                break;
            }
        }
        this.geocodeCache.set(key, entry);
        return entry.point;
    }

    /** Same predicate as dispatch, floater rule and matching switch included. */
    private async covered(
        organisationId: string,
        warehouseId: string,
        point: { lon: number; lat: number },
    ): Promise<boolean> {
        const query = { organisationId, warehouseId };
        const { serviceAreaMatching } = await resolveDispatchSettings(
            this.dataSource,
            organisationId,
        );
        const coverage = serviceAreaMatching
            ? await coveringDriversForPoint(this.dataSource, query, point)
            : await allDriversAsFloatersForPoint(this.dataSource, query);
        return coverage.driverIds.length > 0;
    }

    private async warehousePoint(
        organisationId: string,
        warehouseId: string,
    ): Promise<{ lon: number; lat: number }> {
        const rows: { lon: number; lat: number }[] =
            await this.dataSource.query(
                `SELECT ST_X(warehouse_location::geometry) AS lon,
                        ST_Y(warehouse_location::geometry) AS lat
                   FROM public.warehouse
                  WHERE id = $1 AND organisation_id = $2`,
                [warehouseId, organisationId],
            );
        const row = rows[0];
        if (!row || !isPlausibleLonLat(Number(row.lon), Number(row.lat))) {
            throw new NoRates('warehouse has no location');
        }
        return { lon: Number(row.lon), lat: Number(row.lat) };
    }

    /** The org's active catalog, cached briefly per connected account. */
    private async catalog(
        organisationId: string,
    ): Promise<Map<string, CatalogProduct>> {
        const account = await this.orgs.getStripeAccount(organisationId);
        if (!account?.stripeAccountId) throw new NoRates('no Stripe account');
        const id = account.stripeAccountId;
        const cached = this.catalogCache.get(id);
        if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
            return cached.map;
        }
        const map = await this.services.fetchActiveProductMap(id);
        this.catalogCache.set(id, { at: Date.now(), map });
        return map;
    }
}
