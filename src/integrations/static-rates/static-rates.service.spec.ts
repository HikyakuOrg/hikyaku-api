import {
    ConflictException,
    NotFoundException,
    UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import * as coverage from 'src/dispatch/coverage';
import * as dispatchSettings from 'src/dispatch/dispatch-settings';
import type { CatalogProduct } from 'src/services/services.service';
import type { ShippingRateSettingsService } from '../shipping-rate-settings.service';
import { COVERAGE_BUDGET_BYTES, byteLength } from './coverage-export';
import { StaticRatesService, outerRings } from './static-rates.service';

jest.mock('src/dispatch/coverage', () => ({
    ...jest.requireActual<typeof coverage>('src/dispatch/coverage'),
    floaterDrivers: jest.fn(),
    allDriversAsFloatersForPoint: jest.fn(),
}));
jest.mock('src/dispatch/dispatch-settings', () => ({
    ...jest.requireActual<typeof dispatchSettings>(
        'src/dispatch/dispatch-settings',
    ),
    resolveDispatchSettings: jest.fn(),
}));

const ORG = 'org-1';
const SHOP = 'store.myshopify.com';
const W1 = 'b6ef9918-3656-48f9-bf72-48dba1df4625';
const W2 = 'c7f0aa29-4767-49fa-8f83-59eca2e05736';

const FLAT: CatalogProduct = {
    productId: 'prod_flat',
    name: 'Flat',
    description: 'Same day',
    amountMinor: 1000,
    currency: 'aud',
    currencyOptions: {},
    created: 1,
    pricingUnit: 'per_delivery',
    kind: 'service',
    parentProductId: null,
    defaultPriceId: 'price_flat',
};

const SQUARE = {
    type: 'Polygon',
    coordinates: [
        [
            [144.9, -37.9],
            [145.0, -37.9],
            [145.0, -37.8],
            [144.9, -37.8],
            [144.9, -37.9],
        ],
    ],
};

/** A ring with `n` vertices: too big for the budget at any rounding when n is large. */
function circle(n: number, cx = 145, cy = -37.8) {
    const ring = Array.from({ length: n + 1 }, (_, i) => {
        const a = (i / n) * 2 * Math.PI;
        return [cx + 0.1 * Math.cos(a), cy + 0.1 * Math.sin(a)];
    });
    return { type: 'Polygon', coordinates: [ring] };
}

const floaters = coverage.floaterDrivers as jest.Mock;
const allAsFloaters = coverage.allDriversAsFloatersForPoint as jest.Mock;
const resolveSettings = dispatchSettings.resolveDispatchSettings as jest.Mock;

describe('StaticRatesService', () => {
    let service: StaticRatesService;
    let query: jest.Mock;
    let findOwn: jest.Mock;
    let loadCatalog: jest.Mock;
    let warehouses: { id: string; lon: number; lat: number }[];
    /** The staffed-area rows to return, by simplification tolerance. */
    let ringsAt: (
        tolerance: number,
    ) => { warehouse_id: string; geojson: string }[];

    beforeEach(() => {
        jest.clearAllMocks();
        warehouses = [{ id: W1, lon: 144.96, lat: -37.81 }];
        ringsAt = () => [{ warehouse_id: W1, geojson: JSON.stringify(SQUARE) }];
        query = jest.fn((sql: string, params: unknown[]) => {
            if (sql.includes('FROM public.warehouse w')) {
                return Promise.resolve(warehouses);
            }
            if (sql.includes('st_simplifypreservetopology')) {
                return Promise.resolve(ringsAt(params[2] as number));
            }
            return Promise.reject(new Error(`unexpected SQL: ${sql}`));
        });
        findOwn = jest.fn().mockResolvedValue({
            shop_domain: SHOP,
            enabled: true,
            shop_currency: 'aud',
            service_ids: ['prod_flat'],
            band_settings: {},
        });
        loadCatalog = jest
            .fn()
            .mockResolvedValue({ connected: true, catalog: [FLAT] });
        resolveSettings.mockResolvedValue({ serviceAreaMatching: true });
        floaters.mockResolvedValue([]);
        allAsFloaters.mockResolvedValue({ driverIds: [] });

        service = new StaticRatesService(
            { query } as unknown as DataSource,
            {
                findOwn,
                loadCatalog,
            } as unknown as ShippingRateSettingsService,
        );
    });

    describe('plan', () => {
        it('404s without settings for the shop', async () => {
            findOwn.mockResolvedValue(null);
            await expect(
                service.plan(ORG, 'shopify', SHOP),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('409s while the settings have no shop currency', async () => {
            findOwn.mockResolvedValue({
                shop_domain: SHOP,
                enabled: false,
                shop_currency: null,
                service_ids: [],
                band_settings: {},
            });
            await expect(
                service.plan(ORG, 'shopify', SHOP),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('prices the chosen services in the shop currency', async () => {
            const plan = await service.plan(ORG, 'shopify', SHOP);
            expect(findOwn).toHaveBeenCalledWith(ORG, 'shopify', SHOP);
            expect(plan.currency).toBe('AUD');
            expect(plan.rates).toEqual([
                expect.objectContaining({
                    code: 'hikyaku:prod_flat',
                    kind: 'flat',
                    price: '10.00',
                }),
            ]);
            expect(plan.bbox_fallback).toBe(false);
            expect(plan.coverage.w).toEqual([
                expect.objectContaining({ id: W1, e: false }),
            ]);
        });

        it('has no rates, but still coverage, while rates are off', async () => {
            findOwn.mockResolvedValue({
                shop_domain: SHOP,
                enabled: false,
                shop_currency: 'AUD',
                service_ids: ['prod_flat'],
                band_settings: {},
            });
            const plan = await service.plan(ORG, 'shopify', SHOP);
            expect(loadCatalog).not.toHaveBeenCalled();
            expect(plan.rates).toEqual([]);
            expect(plan.coverage.w).toHaveLength(1);
        });
    });

    describe('coverage', () => {
        it('reads mapped warehouses for the shop only', async () => {
            await service.coverage(ORG, 'shopify', SHOP);
            const [sql, params] = query.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain("m.mode = 'warehouse'");
            expect(sql).toContain('m.stale_at IS NULL');
            expect(params).toEqual([ORG, 'shopify', SHOP]);
        });

        it('writes the staffed areas unsimplified when they fit', async () => {
            const { coverage: json, bboxFallback } = await service.coverage(
                ORG,
                'shopify',
                SHOP,
            );
            expect(bboxFallback).toBe(false);
            expect(json.w[0].p).toEqual([
                [
                    144.9, -37.9, 145, -37.9, 145, -37.8, 144.9, -37.8, 144.9,
                    -37.9,
                ],
            ]);
            const tolerances = query.mock.calls
                .filter(([sql]) =>
                    (sql as string).includes('st_simplifypreservetopology'),
                )
                .map(([, params]) => (params as unknown[])[2]);
            expect(tolerances).toEqual([0]);
        });

        it('simplifies further until the areas fit', async () => {
            ringsAt = (tolerance) => [
                {
                    warehouse_id: W1,
                    geojson: JSON.stringify(
                        tolerance < 0.001 ? circle(2000) : circle(100),
                    ),
                },
            ];
            const { coverage: json, bboxFallback } = await service.coverage(
                ORG,
                'shopify',
                SHOP,
            );
            expect(bboxFallback).toBe(false);
            expect(json.w[0].p[0]).toHaveLength(202);
            expect(byteLength(json)).toBeLessThanOrEqual(COVERAGE_BUDGET_BYTES);
        });

        it('falls back to bounding boxes for a polygon that never fits', async () => {
            ringsAt = () => [
                { warehouse_id: W1, geojson: JSON.stringify(circle(3000)) },
                { warehouse_id: W1, geojson: JSON.stringify(SQUARE) },
            ];
            const { coverage: json, bboxFallback } = await service.coverage(
                ORG,
                'shopify',
                SHOP,
            );
            expect(bboxFallback).toBe(true);
            expect(json.w[0].p).toEqual([]);
            expect(json.w[0].b).toEqual([
                [144.9, -37.9, 145.1, -37.7],
                [144.9, -37.9, 145, -37.8],
            ]);
            expect(byteLength(json)).toBeLessThanOrEqual(COVERAGE_BUDGET_BYTES);
        });

        it('marks a warehouse with a floater as covered everywhere and skips its areas', async () => {
            warehouses = [
                { id: W1, lon: 144.96, lat: -37.81 },
                { id: W2, lon: 145.1, lat: -37.9 },
            ];
            floaters.mockImplementation(
                (_executor: unknown, q: { warehouseId: string }) =>
                    Promise.resolve(q.warehouseId === W2 ? ['d-floater'] : []),
            );
            const { coverage: json } = await service.coverage(
                ORG,
                'shopify',
                SHOP,
            );
            expect(floaters).toHaveBeenCalledWith(expect.anything(), {
                organisationId: ORG,
                warehouseId: W1,
            });
            const ringQuery = query.mock.calls.find(([sql]) =>
                (sql as string).includes('st_simplifypreservetopology'),
            ) as [string, unknown[]];
            expect(ringQuery[1][1]).toEqual([W1]);
            expect(json.w).toEqual([
                expect.objectContaining({ id: W1, e: false }),
                expect.objectContaining({ id: W2, e: true, p: [], b: [] }),
            ]);
        });

        it('with matching off, covers everywhere a warehouse with any driver', async () => {
            resolveSettings.mockResolvedValue({ serviceAreaMatching: false });
            warehouses = [
                { id: W1, lon: 144.96, lat: -37.81 },
                { id: W2, lon: 145.1, lat: -37.9 },
            ];
            allAsFloaters.mockImplementation(
                (_executor: unknown, q: { warehouseId: string }) =>
                    Promise.resolve({
                        driverIds: q.warehouseId === W1 ? ['d1'] : [],
                    }),
            );
            const { coverage: json } = await service.coverage(
                ORG,
                'shopify',
                SHOP,
            );
            expect(floaters).not.toHaveBeenCalled();
            expect(
                query.mock.calls.some(([sql]) =>
                    (sql as string).includes('st_simplifypreservetopology'),
                ),
            ).toBe(false);
            expect(json.w).toEqual([
                expect.objectContaining({ id: W1, e: true }),
                expect.objectContaining({ id: W2, e: false, p: [], b: [] }),
            ]);
        });

        it('422s when even one box per warehouse does not fit', async () => {
            warehouses = Array.from({ length: 150 }, (_, i) => ({
                id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
                lon: 144 + i / 100,
                lat: -37,
            }));
            ringsAt = () =>
                warehouses.map((w) => ({
                    warehouse_id: w.id,
                    geojson: JSON.stringify(circle(40, w.lon, w.lat)),
                }));
            await expect(
                service.coverage(ORG, 'shopify', SHOP),
            ).rejects.toBeInstanceOf(UnprocessableEntityException);
        });
    });
});

describe('outerRings', () => {
    it('keeps a polygon outer ring and drops its holes', () => {
        const hole = [
            [144.95, -37.85],
            [144.96, -37.85],
            [144.96, -37.84],
            [144.95, -37.85],
        ];
        expect(
            outerRings(
                JSON.stringify({
                    type: 'Polygon',
                    coordinates: [SQUARE.coordinates[0], hole],
                }),
            ),
        ).toEqual([SQUARE.coordinates[0]]);
    });

    it('takes every outer ring of a multipolygon', () => {
        const other = circle(4).coordinates[0];
        expect(
            outerRings(
                JSON.stringify({
                    type: 'MultiPolygon',
                    coordinates: [[SQUARE.coordinates[0]], [other]],
                }),
            ),
        ).toEqual([SQUARE.coordinates[0], other]);
    });

    it('ignores nothing, empty and other geometry types', () => {
        expect(outerRings(null)).toEqual([]);
        expect(
            outerRings(JSON.stringify({ type: 'Polygon', coordinates: [] })),
        ).toEqual([]);
        expect(
            outerRings(JSON.stringify({ type: 'Point', coordinates: [1, 2] })),
        ).toEqual([]);
    });
});
