import {
    ConflictException,
    Injectable,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    allDriversAsFloatersForPoint,
    floaterDrivers,
} from 'src/dispatch/coverage';
import { resolveDispatchSettings } from 'src/dispatch/dispatch-settings';
import { priceableServices } from '../carrier-rates/carrier-rates';
import { ShippingRateSettingsService } from '../shipping-rate-settings.service';
import { buildStaticRates, type StaticRate } from './band-plan';
import {
    COVERAGE_BUDGET_BYTES,
    byteLength,
    encodeCoverage,
    toBoundingBoxes,
    toOneBoxPerWarehouse,
    type CoverageJson,
    type WarehouseCoverage,
} from './coverage-export';

export interface StaticPlan {
    currency: string;
    rates: StaticRate[];
    coverage: CoverageJson;
    bbox_fallback: boolean;
}

/**
 * Simplification tolerances in degrees, tried in order until the coverage
 * fits the metafield, with the coordinate decimals each is written with.
 * 0.0001° is about 10 m; 0.01° about 1 km.
 */
const SIMPLIFY_STEPS: { tolerance: number; decimals: number }[] = [
    { tolerance: 0, decimals: 5 },
    { tolerance: 0.0001, decimals: 5 },
    { tolerance: 0.0003, decimals: 4 },
    { tolerance: 0.001, decimals: 4 },
    { tolerance: 0.003, decimals: 4 },
    { tolerance: 0.01, decimals: 3 },
];

interface WarehouseRow {
    id: string;
    lon: number;
    lat: number;
}

/**
 * Builds a shop's static plan: the fixed rates the app writes into its
 * delivery profiles, and the coverage its Delivery Customization Function
 * filters them with. Everything is computed here so the app only writes what
 * it's given.
 */
@Injectable()
export class StaticRatesService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly settings: ShippingRateSettingsService,
    ) {}

    async plan(
        organisationId: string,
        platform: string,
        shopDomain: string,
    ): Promise<StaticPlan> {
        const row = await this.settings.findOwn(
            organisationId,
            platform,
            shopDomain,
        );
        if (!row) {
            throw new NotFoundException(
                'No shipping rate settings for this shop.',
            );
        }
        if (!row.shop_currency) {
            throw new ConflictException(
                'Save the shop currency in the rate settings first.',
            );
        }
        const currency = row.shop_currency.toUpperCase();

        let rates: StaticRate[] = [];
        if (row.enabled) {
            const { catalog } = await this.settings.loadCatalog(organisationId);
            const services = priceableServices(
                row.service_ids,
                new Map(catalog.map((s) => [s.productId, s])),
                currency,
            );
            rates = buildStaticRates(services, row.band_settings, currency);
        }

        const { coverage, bboxFallback } = await this.coverage(
            organisationId,
            platform,
            row.shop_domain,
        );
        return { currency, rates, coverage, bbox_fallback: bboxFallback };
    }

    /**
     * The coverage JSON for the shop's mapped warehouses, simplified until it
     * fits COVERAGE_BUDGET_BYTES, then as bounding boxes.
     */
    async coverage(
        organisationId: string,
        platform: string,
        shopDomain: string,
    ): Promise<{ coverage: CoverageJson; bboxFallback: boolean }> {
        const warehouses = await this.mappedWarehouses(
            organisationId,
            platform,
            shopDomain,
        );
        const { serviceAreaMatching } = await resolveDispatchSettings(
            this.dataSource,
            organisationId,
        );

        const base: Omit<WarehouseCoverage, 'rings'>[] = [];
        for (const w of warehouses) {
            const query = { organisationId, warehouseId: w.id };
            // Matching off: dispatch treats every driver as a floater, so a
            // warehouse with any driver covers everywhere, and one without
            // covers nothing.
            const everywhere = serviceAreaMatching
                ? (await floaterDrivers(this.dataSource, query)).length > 0
                : (await allDriversAsFloatersForPoint(this.dataSource, query))
                      .driverIds.length > 0;
            base.push({
                id: w.id,
                lon: Number(w.lon),
                lat: Number(w.lat),
                everywhere,
                boxes: [],
            });
        }

        const shaped = serviceAreaMatching
            ? base.filter((w) => !w.everywhere).map((w) => w.id)
            : [];
        let exact: WarehouseCoverage[] | null = null;
        for (const step of SIMPLIFY_STEPS) {
            const rings = await this.staffedRings(
                organisationId,
                shaped,
                step.tolerance,
            );
            const withRings = base.map((w) => ({
                ...w,
                rings: rings.get(w.id) ?? [],
            }));
            exact ??= withRings;
            const json = encodeCoverage(withRings, step.decimals);
            if (byteLength(json) <= COVERAGE_BUDGET_BYTES) {
                return { coverage: json, bboxFallback: false };
            }
        }

        // Boxes from the unsimplified rings, so no box is too small.
        for (const boxed of [
            toBoundingBoxes(exact ?? []),
            toOneBoxPerWarehouse(exact ?? []),
        ]) {
            const json = encodeCoverage(boxed, 4);
            if (byteLength(json) <= COVERAGE_BUDGET_BYTES) {
                return { coverage: json, bboxFallback: true };
            }
        }
        throw new UnprocessableEntityException(
            'This shop maps too many warehouses to fit the checkout coverage in 10 KB.',
        );
    }

    /** Warehouses a live location of the shop ships from, by id. */
    private async mappedWarehouses(
        organisationId: string,
        platform: string,
        shopDomain: string,
    ): Promise<WarehouseRow[]> {
        return this.dataSource.query(
            `SELECT w.id,
                    ST_X(w.warehouse_location::geometry) AS lon,
                    ST_Y(w.warehouse_location::geometry) AS lat
               FROM public.warehouse w
              WHERE w.organisation_id = $1
                AND w.warehouse_location IS NOT NULL
                AND w.id IN (
                    SELECT m.warehouse_id
                      FROM public.integration_location_mapping m
                     WHERE m.organisation_id = $1 AND m.platform = $2
                       AND m.shop_domain = $3 AND m.mode = 'warehouse'
                       AND m.stale_at IS NULL
                )
              ORDER BY w.id`,
            [organisationId, platform, shopDomain],
        );
    }

    /**
     * Outer rings of each warehouse's staffed live areas, simplified at
     * `tolerance`: the areas a driver of that warehouse is linked to, which is
     * what explicit coverage in `coveringDriversForPoints` joins through.
     */
    private async staffedRings(
        organisationId: string,
        warehouseIds: string[],
        tolerance: number,
    ): Promise<Map<string, [number, number][][]>> {
        const out = new Map<string, [number, number][][]>();
        if (warehouseIds.length === 0) return out;
        const rows: { warehouse_id: string; geojson: string }[] =
            await this.dataSource.query(
                `SELECT DISTINCT d.warehouse_id, sa.id,
                        extensions.st_asgeojson(
                            extensions.st_simplifypreservetopology(
                                extensions.st_setsrid(sa.geometry, 4326), $3),
                            6) AS geojson
                   FROM public.service_areas sa
                   JOIN public.driver_service_area dsa ON dsa.service_area_id = sa.id
                   JOIN public.drivers d ON d.id = dsa.driver_id
                  WHERE sa.organisation_id = $1 AND sa.is_deleted = false
                    AND d.organisation_id = $1
                    AND d.warehouse_id = ANY($2::uuid[])
                  ORDER BY d.warehouse_id, sa.id`,
                [organisationId, warehouseIds, tolerance],
            );
        for (const row of rows) {
            const rings = outerRings(row.geojson);
            if (rings.length === 0) continue;
            out.set(row.warehouse_id, [
                ...(out.get(row.warehouse_id) ?? []),
                ...rings,
            ]);
        }
        return out;
    }
}

/** The outer rings of a GeoJSON Polygon or MultiPolygon. */
export function outerRings(geojson: string | null): [number, number][][] {
    if (!geojson) return [];
    const g = JSON.parse(geojson) as {
        type?: string;
        coordinates?: unknown;
    };
    if (g.type === 'Polygon') {
        const rings = g.coordinates as [number, number][][];
        return rings[0]?.length ? [rings[0]] : [];
    }
    if (g.type === 'MultiPolygon') {
        return (g.coordinates as [number, number][][][])
            .map((polygon) => polygon[0])
            .filter((ring) => ring?.length > 0);
    }
    return [];
}
