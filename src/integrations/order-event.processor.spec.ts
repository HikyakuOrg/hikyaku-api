import { DataSource } from 'typeorm';
import { CustomersService } from 'src/customers/customers.service';
import { PackagesService } from 'src/packages/packages.service';
import type {
    OrderDeliveryAddressDto,
    OrderEventDto,
    OrderFulfillmentGroupDto,
} from './dto/order-event.dto';
import {
    OrderEventProcessor,
    groupWeightKg,
    platformLabel,
    weightKg,
    type ClaimedOrderEvent,
} from './order-event.processor';
import {
    OrderGeocoder,
    UngeocodableAddressError,
    type GeocodedPoint,
} from './order-geocoder';

type QueryMock = jest.Mock<Promise<unknown>, [string, unknown[]?]>;

const payload = (overrides: Record<string, unknown> = {}): OrderEventDto =>
    ({
        event: {
            id: 'evt-1',
            type: 'order.paid',
            occurred_at: '2026-09-27T00:00:00Z',
            api_version: '2025-01',
        },
        source: {
            platform: 'shopify',
            shop_domain: 'hikyaku.myshopify.com',
            app_version: '0.1.0',
        },
        order: {
            id: 'gid://shopify/Order/1',
            name: '#1001',
            total_weight_grams: 1200,
            line_items: [],
        },
        customer: {
            id: '700000000001',
            first_name: 'Test',
            last_name: 'Recipient',
            email: 'customer@example.com',
            phone: null,
        },
        delivery: {
            required: true,
            recipient_name: 'Test Recipient',
            phone: '+61 400 000 000',
            email: 'recipient@example.com',
            address: {
                line1: '100 Collins St',
                line2: 'Level 2',
                city: 'Melbourne',
                province: 'Victoria',
                province_code: 'VIC',
                postcode: '3000',
                country: 'Australia',
                country_code: 'AU',
                company: null,
            },
            latitude: null,
            longitude: null,
            shipping_method: 'Standard Delivery',
            instructions: 'Leave at reception',
        },
        ...overrides,
    }) as unknown as OrderEventDto;

const event = (
    overrides: Partial<ClaimedOrderEvent> = {},
): ClaimedOrderEvent => ({
    id: 'ledger-1',
    organisation_id: 'org-1',
    platform: 'shopify',
    event_type: 'order.paid',
    payload: payload(),
    attempts: 1,
    ...overrides,
});

const warehouse = (id: string, name: string, lon: number, lat: number) => ({
    id,
    warehouse_name: name,
    warehouse_address: `1 ${name} Rd`,
    warehouse_city: name,
    warehouse_state: 'VIC',
    warehouse_zipcode: '3008',
    warehouse_country: 'AU',
    lon,
    lat,
});

const WAREHOUSE = warehouse('wh-1', 'Docklands', 144.94, -37.82);
const MELBOURNE = warehouse('wh-mel', 'Melbourne DC', 144.96, -37.81);
const SYDNEY = warehouse('wh-syd', 'Sydney DC', 151.2, -33.87);

type Warehouse = typeof WAREHOUSE;

interface PackageRow {
    id: string;
    to_customer: string;
    external_fulfillment_id: string | null;
}

interface MappingRow {
    external_location_id: string;
    external_location_name: string | null;
    mode: 'warehouse' | 'not_delivered' | 'unmapped';
    warehouse_id: string | null;
}

/** A mapping row as the LEFT JOIN returns it. */
const mapping = (
    locationId: string,
    name: string | null,
    mode: MappingRow['mode'],
    wh?: Warehouse,
): MappingRow & Partial<Omit<Warehouse, 'id'>> => {
    const { id, ...rest } = wh ?? { id: null };
    return {
        external_location_id: locationId,
        external_location_name: name,
        mode,
        warehouse_id: id,
        ...rest,
    };
};

const group = (
    id: string,
    locationId: string,
    locationName: string | null,
    lineItems: { line_item_id: string; quantity: number }[],
    overrides: Partial<OrderFulfillmentGroupDto> = {},
): OrderFulfillmentGroupDto => ({
    id,
    external_location_id: locationId,
    external_location_name: locationName,
    delivery_method: 'shipping',
    line_items: lineItems,
    total_weight_grams: null,
    ...overrides,
});

/** An order whose items ship from a Melbourne and a Sydney location. */
const groupedPayload = (
    groups: OrderFulfillmentGroupDto[] = [
        group('fo-1', 'loc-mel', 'Melbourne DC', [
            { line_item_id: 'li-1', quantity: 2 },
        ]),
        group('fo-2', 'loc-syd', 'Sydney DC', [
            { line_item_id: 'li-2', quantity: 1 },
        ]),
    ],
): OrderEventDto =>
    payload({
        order: {
            id: 'gid://shopify/Order/1',
            name: '#1001',
            total_weight_grams: 1400,
            line_items: [
                {
                    id: 'li-1',
                    grams: 200,
                    quantity: 2,
                    requires_shipping: true,
                },
                {
                    id: 'li-2',
                    grams: 1000,
                    quantity: 1,
                    requires_shipping: true,
                },
            ],
        },
        fulfillment_groups: groups,
    });

describe('OrderEventProcessor', () => {
    let state: {
        packages: PackageRow[];
        warehouse: Warehouse | null;
        mappings: ReturnType<typeof mapping>[];
    };
    let query: QueryMock;
    let runner: {
        connect: jest.Mock;
        startTransaction: jest.Mock;
        commitTransaction: jest.Mock;
        rollbackTransaction: jest.Mock;
        release: jest.Mock;
        query: QueryMock;
        isTransactionActive: boolean;
    };
    let customers: {
        upsertFromExternalOrder: jest.Mock<
            Promise<string>,
            Parameters<CustomersService['upsertFromExternalOrder']>
        >;
    };
    let packages: {
        createMany: jest.Mock<
            Promise<string[]>,
            Parameters<PackagesService['createMany']>
        >;
        assignCreated: jest.Mock<
            Promise<void>,
            Parameters<PackagesService['assignCreated']>
        >;
    };
    let geocoder: {
        geocodeAddress: jest.Mock<
            Promise<GeocodedPoint>,
            [OrderDeliveryAddressDto]
        >;
    };
    let processor: OrderEventProcessor;

    /** Params of every statement sent through `mock` whose SQL has `marker`. */
    const paramsOf = (mock: QueryMock, marker: string): unknown[][] =>
        mock.mock.calls
            .filter(([sql]) => sql.includes(marker))
            .map(([, params]) => params ?? []);

    /** Params of every ledger UPDATE sent through `mock`. */
    const ledgerUpdates = (mock: QueryMock): unknown[][] =>
        paramsOf(mock, 'UPDATE public.integration_order_event');

    /** Params of every link INSERT sent through `mock`. */
    const links = (mock: QueryMock): unknown[][] =>
        paramsOf(mock, 'INSERT INTO public.integration_order_event_package');

    const specs = () => packages.createMany.mock.calls.map(([, , s]) => s[0]);

    beforeEach(() => {
        state = { packages: [], warehouse: WAREHOUSE, mappings: [] };
        query = jest.fn((sql: string, params?: unknown[]): Promise<unknown> => {
            if (sql.includes('FROM public.integration_location_mapping')) {
                const ids = params![3] as string[];
                return Promise.resolve(
                    state.mappings.filter((m) =>
                        ids.includes(m.external_location_id),
                    ),
                );
            }
            if (sql.includes('FROM packages')) {
                return Promise.resolve([...state.packages]);
            }
            if (sql.includes('FROM warehouse')) {
                return Promise.resolve(
                    state.warehouse ? [state.warehouse] : [],
                );
            }
            return Promise.resolve([]);
        });
        runner = {
            connect: jest.fn(),
            startTransaction: jest.fn(() => {
                runner.isTransactionActive = true;
            }),
            commitTransaction: jest.fn(() => {
                runner.isTransactionActive = false;
            }),
            rollbackTransaction: jest.fn(() => {
                runner.isTransactionActive = false;
            }),
            release: jest.fn(),
            query: jest.fn<Promise<unknown>, [string, unknown[]?]>(() =>
                Promise.resolve([]),
            ),
            isTransactionActive: false,
        };
        customers = {
            // The recipient is a person; a sender is "<store> (<warehouse>)".
            upsertFromExternalOrder: jest.fn<
                Promise<string>,
                Parameters<CustomersService['upsertFromExternalOrder']>
            >((_org, person) => {
                const at = /\((.+)\)$/.exec(person.name)?.[1];
                return Promise.resolve(
                    at
                        ? `cust-sender-${at.toLowerCase().replace(/ /g, '-')}`
                        : 'cust-recipient',
                );
            }),
        };
        packages = {
            // Stands in for the packages table, so a later event sees what an
            // earlier one made.
            createMany: jest.fn<
                Promise<string[]>,
                Parameters<PackagesService['createMany']>
            >((_runner, _org, [spec]) => {
                const id = `pkg-${state.packages.length + 1}`;
                state.packages.push({
                    id,
                    to_customer: spec.toCustomerId,
                    external_fulfillment_id:
                        spec.externalOrder?.fulfillmentId ?? null,
                });
                return Promise.resolve([id]);
            }),
            assignCreated: jest
                .fn<
                    Promise<void>,
                    Parameters<PackagesService['assignCreated']>
                >()
                .mockResolvedValue(undefined),
        };
        geocoder = {
            geocodeAddress: jest
                .fn<Promise<GeocodedPoint>, [OrderDeliveryAddressDto]>()
                .mockResolvedValue({
                    lon: 144.97,
                    lat: -37.814,
                    confidence: 1,
                    gid: 'osm:W/1',
                    raw: { some: 'feature' },
                }),
        };
        processor = new OrderEventProcessor(
            {
                query,
                createQueryRunner: () => runner,
            } as unknown as DataSource,
            customers as unknown as CustomersService,
            packages as unknown as PackagesService,
            geocoder as unknown as OrderGeocoder,
        );
    });

    describe('an order without fulfillment groups', () => {
        it('turns a paid order into a customer and a package, links it on the same transaction, then assigns', async () => {
            const outcome = await processor.process(event());

            expect(outcome).toEqual({
                status: 'processed',
                customerId: 'cust-recipient',
                packageIds: ['pkg-1'],
            });

            const [orgId, person, external] =
                customers.upsertFromExternalOrder.mock.calls[0];
            expect(orgId).toBe('org-1');
            expect(person).toEqual({
                name: 'Test Recipient',
                phone: '+61400000000',
                email: 'recipient@example.com',
                address: {
                    lon: 144.97,
                    lat: -37.814,
                    street: '100 Collins St',
                    unit: 'Level 2',
                    suburb: 'Melbourne',
                    state: 'VIC',
                    postcode: '3000',
                    country: 'AU',
                },
                confidence: 1,
                peliasGid: 'osm:W/1',
                peliasRaw: { some: 'feature' },
            });
            expect(external).toEqual({
                platform: 'shopify',
                externalCustomerId: '700000000001',
            });

            // The sender is the store, at its nearest warehouse.
            const [, sender, senderExternal] =
                customers.upsertFromExternalOrder.mock.calls[1];
            expect(sender).toMatchObject({
                name: 'hikyaku.myshopify.com (Docklands)',
                phone: null,
                email: null,
                address: { lon: 144.94, lat: -37.82, street: '1 Docklands Rd' },
            });
            expect(senderExternal).toBeNull();

            const [txRunner, pkgOrg, created] =
                packages.createMany.mock.calls[0];
            expect(txRunner).toBe(runner);
            expect(pkgOrg).toBe('org-1');
            expect(created).toEqual([
                {
                    warehouseId: 'wh-1',
                    fromCustomerId: 'cust-sender-docklands',
                    toCustomerId: 'cust-recipient',
                    deliveryNotes: 'Leave at reception',
                    weightKg: 1.2,
                    lengthCm: 30,
                    widthCm: 20,
                    heightCm: 15,
                    deadlineAt: null,
                    externalOrder: {
                        platform: 'shopify',
                        id: 'gid://shopify/Order/1',
                        name: '#1001',
                        fulfillmentId: null,
                    },
                },
            ]);

            expect(links(runner.query)).toEqual([
                ['ledger-1', ['pkg-1'], [null]],
            ]);
            expect(runner.commitTransaction).toHaveBeenCalled();
            expect(ledgerUpdates(query)).toEqual([
                ['ledger-1', 'processed', 'cust-recipient', 'pkg-1', null],
            ]);

            expect(packages.assignCreated).toHaveBeenCalledWith('org-1', [
                'pkg-1',
            ]);
        });

        it('still reports processed when assignment throws: the package is committed', async () => {
            packages.assignCreated.mockRejectedValue(new Error('lock timeout'));
            await expect(processor.process(event())).resolves.toMatchObject({
                status: 'processed',
                packageIds: ['pkg-1'],
            });
        });

        it('uses the storefront coordinates when it sends them, without calling Photon', async () => {
            const p = payload();
            p.delivery.latitude = -37.8;
            p.delivery.longitude = 144.9;

            await processor.process(event({ payload: p }));

            expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
            const [, person] = customers.upsertFromExternalOrder.mock.calls[0];
            expect(person.address).toMatchObject({ lon: 144.9, lat: -37.8 });
            expect(person.peliasGid).toBeNull();
        });

        it('treats an empty fulfillment_groups like none at all', async () => {
            const outcome = await processor.process(
                event({ payload: payload({ fulfillment_groups: [] }) }),
            );

            expect(outcome.status).toBe('processed');
            expect(specs()[0].warehouseId).toBe('wh-1');
        });

        it('skips an event type that creates nothing', async () => {
            const outcome = await processor.process(
                event({ event_type: 'order.cancelled' }),
            );

            expect(outcome.status).toBe('skipped');
            expect(ledgerUpdates(query)[0]).toEqual([
                'ledger-1',
                'skipped',
                null,
                null,
                'Event type "order.cancelled" does not create a package.',
            ]);
            expect(packages.createMany).not.toHaveBeenCalled();
        });

        it.each([
            ['no delivery required', { required: false }],
            ['no address', { address: null }],
        ])('skips an order with %s', async (_label, delivery) => {
            const p = payload();
            Object.assign(p.delivery, delivery);

            const outcome = await processor.process(event({ payload: p }));

            expect(outcome.status).toBe('skipped');
            expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
            expect(customers.upsertFromExternalOrder).not.toHaveBeenCalled();
        });

        it('records an ungeocodable address as needs_attention, creating nothing', async () => {
            geocoder.geocodeAddress.mockRejectedValue(
                new UngeocodableAddressError('Could not find it.'),
            );

            const outcome = await processor.process(event());

            expect(outcome).toEqual({
                status: 'needs_attention',
                error: 'Could not find it.',
            });
            expect(ledgerUpdates(query)[0]).toEqual([
                'ledger-1',
                'needs_attention',
                null,
                null,
                'Could not find it.',
            ]);
            expect(customers.upsertFromExternalOrder).not.toHaveBeenCalled();
            expect(packages.createMany).not.toHaveBeenCalled();
        });

        it('rethrows a geocoder outage so the worker retries it', async () => {
            const down = new Error('Photon timed out');
            geocoder.geocodeAddress.mockRejectedValue(down);

            await expect(processor.process(event())).rejects.toBe(down);
            expect(ledgerUpdates(query)).toHaveLength(0);
        });

        it('needs attention, keeping the customer, when the organisation has no warehouse', async () => {
            state.warehouse = null;

            const outcome = await processor.process(event());

            expect(outcome).toMatchObject({
                status: 'needs_attention',
                customerId: 'cust-recipient',
            });
            expect(ledgerUpdates(query)[0][2]).toBe('cust-recipient');
            expect(packages.createMany).not.toHaveBeenCalled();
        });

        it('links to the existing package when the order already produced one, creating nothing', async () => {
            state.packages = [
                {
                    id: 'pkg-old',
                    to_customer: 'cust-old',
                    external_fulfillment_id: null,
                },
            ];

            const outcome = await processor.process(event());

            expect(outcome).toEqual({
                status: 'processed',
                customerId: 'cust-old',
                packageIds: ['pkg-old'],
            });
            expect(links(query)).toEqual([['ledger-1', ['pkg-old'], [null]]]);
            expect(ledgerUpdates(query)).toHaveLength(1);
            expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
            expect(packages.createMany).not.toHaveBeenCalled();
            expect(packages.assignCreated).not.toHaveBeenCalled();
        });

        it('resolves a lost race for the same order to the winner’s package', async () => {
            packages.createMany.mockImplementation(() => {
                state.packages = [
                    {
                        id: 'pkg-winner',
                        to_customer: 'cust-w',
                        external_fulfillment_id: null,
                    },
                ];
                return Promise.reject(
                    Object.assign(new Error('dup'), { code: '23505' }),
                );
            });

            const outcome = await processor.process(event());

            expect(outcome).toEqual({
                status: 'processed',
                customerId: 'cust-recipient',
                packageIds: ['pkg-winner'],
            });
            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(runner.release).toHaveBeenCalled();
            expect(links(query)).toEqual([
                ['ledger-1', ['pkg-winner'], [null]],
            ]);
            expect(ledgerUpdates(query)[0][3]).toBe('pkg-winner');
            expect(packages.assignCreated).not.toHaveBeenCalled();
        });

        it('rethrows a 23505 when no winner can be found, and any other insert error', async () => {
            const dup = Object.assign(new Error('dup'), { code: '23505' });
            packages.createMany.mockRejectedValueOnce(dup);
            await expect(processor.process(event())).rejects.toBe(dup);

            const fk = Object.assign(new Error('fk'), { code: '23503' });
            packages.createMany.mockRejectedValueOnce(fk);
            await expect(processor.process(event())).rejects.toBe(fk);
        });

        it('falls back through the customer name, a non-E.164 phone and the order email', async () => {
            const p = payload();
            p.delivery.recipient_name = null;
            p.delivery.phone = '0400 000 000';
            p.delivery.email = null;
            p.customer.id = null;

            await processor.process(event({ payload: p }));

            const [, person, external] =
                customers.upsertFromExternalOrder.mock.calls[0];
            expect(person).toMatchObject({
                name: 'Test Recipient',
                phone: null,
                email: 'customer@example.com',
            });
            expect(external).toBeNull();
        });

        it('names a recipient after the company, then the order, when there is no person', async () => {
            const p = payload();
            p.delivery.recipient_name = '  ';
            p.customer.first_name = null;
            p.customer.last_name = null;
            p.delivery.address!.company = 'Acme Pty Ltd';

            await processor.process(event({ payload: p }));
            expect(
                customers.upsertFromExternalOrder.mock.calls[0][1].name,
            ).toBe('Acme Pty Ltd');

            state.packages = [];
            p.delivery.address!.company = null;
            await processor.process(event({ payload: p }));
            expect(
                customers.upsertFromExternalOrder.mock.calls[2][1].name,
            ).toBe('Order #1001');
        });

        it('maps a missing province code, city and country code to what is there', async () => {
            const p = payload();
            Object.assign(p.delivery.address!, {
                province_code: null,
                city: null,
                country_code: null,
            });
            p.source.shop_domain = null;

            await processor.process(event({ payload: p }));

            const [, person] = customers.upsertFromExternalOrder.mock.calls[0];
            expect(person.address).toMatchObject({
                state: 'Victoria',
                suburb: '',
                country: 'Australia',
            });
            expect(
                customers.upsertFromExternalOrder.mock.calls[1][1].name,
            ).toBe('shopify (Docklands)');
        });
    });

    describe('an order with fulfillment groups', () => {
        const UNMAPPED_SYDNEY =
            "Shopify location 'Sydney DC' isn't mapped to a Hikyaku warehouse. Map it in the Shopify app, then retry.";

        const grouped = (
            overrides: Partial<ClaimedOrderEvent> = {},
            groups?: OrderFulfillmentGroupDto[],
        ) => event({ payload: groupedPayload(groups), ...overrides });

        it('makes one package per group, each from its mapped warehouse, and assigns both', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
                mapping('loc-syd', 'Sydney DC', 'warehouse', SYDNEY),
            ];

            const outcome = await processor.process(grouped());

            expect(outcome).toEqual({
                status: 'processed',
                customerId: 'cust-recipient',
                packageIds: ['pkg-1', 'pkg-2'],
            });

            const [sql, params] = query.mock.calls.find(([s]) =>
                s.includes('FROM public.integration_location_mapping'),
            )!;
            expect(sql).toContain('m.shop_domain = $3');
            expect(params).toEqual([
                'org-1',
                'shopify',
                'hikyaku.myshopify.com',
                ['loc-mel', 'loc-syd'],
            ]);

            // Never the nearest warehouse.
            expect(
                query.mock.calls.some(([s]) => s.includes('FROM warehouse')),
            ).toBe(false);
            // One recipient for the whole order, one geocode.
            expect(geocoder.geocodeAddress).toHaveBeenCalledTimes(1);
            const senders = customers.upsertFromExternalOrder.mock.calls
                .slice(1)
                .map(([, person]) => person);
            expect(senders).toEqual([
                expect.objectContaining({
                    name: 'hikyaku.myshopify.com (Melbourne DC)',
                    address: expect.objectContaining({
                        lon: 144.96,
                        lat: -37.81,
                    }) as unknown,
                }),
                expect.objectContaining({
                    name: 'hikyaku.myshopify.com (Sydney DC)',
                    address: expect.objectContaining({
                        lon: 151.2,
                        lat: -33.87,
                    }) as unknown,
                }),
            ]);

            expect(specs()).toEqual([
                expect.objectContaining({
                    warehouseId: 'wh-mel',
                    fromCustomerId: 'cust-sender-melbourne-dc',
                    toCustomerId: 'cust-recipient',
                    // 2 x 200 g of li-1.
                    weightKg: 0.4,
                    externalOrder: {
                        platform: 'shopify',
                        id: 'gid://shopify/Order/1',
                        name: '#1001',
                        fulfillmentId: 'fo-1',
                    },
                }),
                expect.objectContaining({
                    warehouseId: 'wh-syd',
                    fromCustomerId: 'cust-sender-sydney-dc',
                    weightKg: 1,
                    externalOrder: expect.objectContaining({
                        fulfillmentId: 'fo-2',
                    }) as unknown,
                }),
            ]);

            // Each package commits with its own link.
            expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
            expect(links(runner.query)).toEqual([
                ['ledger-1', ['pkg-1'], ['fo-1']],
                ['ledger-1', ['pkg-2'], ['fo-2']],
            ]);
            expect(ledgerUpdates(query)).toEqual([
                ['ledger-1', 'processed', 'cust-recipient', 'pkg-1', null],
            ]);
            expect(packages.assignCreated).toHaveBeenCalledWith('org-1', [
                'pkg-1',
                'pkg-2',
            ]);
        });

        it('makes the mapped group’s package and needs attention for the unmapped one; a retry after mapping it makes only the second', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
            ];

            const first = await processor.process(grouped());

            expect(first).toEqual({
                status: 'needs_attention',
                error: UNMAPPED_SYDNEY,
                customerId: 'cust-recipient',
                packageIds: ['pkg-1'],
            });
            expect(ledgerUpdates(query)).toEqual([
                [
                    'ledger-1',
                    'needs_attention',
                    'cust-recipient',
                    'pkg-1',
                    UNMAPPED_SYDNEY,
                ],
            ]);
            expect(packages.assignCreated).toHaveBeenLastCalledWith('org-1', [
                'pkg-1',
            ]);

            // The merchant maps Sydney, then POST .../retry re-queues the row.
            state.mappings.push(
                mapping('loc-syd', 'Sydney DC', 'warehouse', SYDNEY),
            );
            query.mockClear();
            runner.query.mockClear();

            const retried = await processor.process(grouped({ attempts: 1 }));

            expect(retried).toEqual({
                status: 'processed',
                customerId: 'cust-recipient',
                packageIds: ['pkg-1', 'pkg-2'],
            });
            expect(packages.createMany).toHaveBeenCalledTimes(2);
            expect(specs()[1]).toMatchObject({
                warehouseId: 'wh-syd',
                externalOrder: { fulfillmentId: 'fo-2' },
            });
            // The first package is linked again (a no-op), never remade or
            // reassigned.
            expect(links(query)).toEqual([['ledger-1', ['pkg-1'], ['fo-1']]]);
            expect(links(runner.query)).toEqual([
                ['ledger-1', ['pkg-2'], ['fo-2']],
            ]);
            expect(packages.assignCreated).toHaveBeenLastCalledWith('org-1', [
                'pkg-2',
            ]);
            expect(ledgerUpdates(query)).toEqual([
                ['ledger-1', 'processed', 'cust-recipient', 'pkg-1', null],
            ]);
        });

        it('creates nothing on a replay, under the same key or a new one', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
                mapping('loc-syd', 'Sydney DC', 'warehouse', SYDNEY),
            ];
            await processor.process(grouped());
            geocoder.geocodeAddress.mockClear();
            packages.assignCreated.mockClear();
            query.mockClear();

            const sameRow = await processor.process(grouped());
            const newKey = await processor.process(grouped({ id: 'ledger-2' }));

            for (const outcome of [sameRow, newKey]) {
                expect(outcome).toEqual({
                    status: 'processed',
                    customerId: 'cust-recipient',
                    packageIds: ['pkg-1', 'pkg-2'],
                });
            }
            expect(packages.createMany).toHaveBeenCalledTimes(2);
            expect(packages.assignCreated).not.toHaveBeenCalled();
            expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
            expect(links(query)).toEqual([
                ['ledger-1', ['pkg-1', 'pkg-2'], ['fo-1', 'fo-2']],
                ['ledger-2', ['pkg-1', 'pkg-2'], ['fo-1', 'fo-2']],
            ]);
        });

        it('never splits an order that already became one whole-order package', async () => {
            state.packages = [
                {
                    id: 'pkg-whole',
                    to_customer: 'cust-old',
                    external_fulfillment_id: null,
                },
            ];

            const outcome = await processor.process(grouped());

            expect(outcome).toEqual({
                status: 'processed',
                customerId: 'cust-old',
                packageIds: ['pkg-whole'],
            });
            expect(packages.createMany).not.toHaveBeenCalled();
            expect(
                query.mock.calls.some(([s]) =>
                    s.includes('integration_location_mapping'),
                ),
            ).toBe(false);
        });

        it('needs attention without guessing a warehouse when no group is mapped', async () => {
            state.mappings = [mapping('loc-syd', 'Sydney DC', 'unmapped')];

            const outcome = await processor.process(
                grouped({}, [
                    group('fo-1', 'loc-mel', null, [
                        { line_item_id: 'li-1', quantity: 2 },
                    ]),
                    group('fo-2', 'loc-syd', 'Sydney DC', [
                        { line_item_id: 'li-2', quantity: 1 },
                    ]),
                ]),
            );

            expect(outcome).toEqual({
                status: 'needs_attention',
                error:
                    "Shopify location 'loc-mel' isn't mapped to a Hikyaku warehouse. Map it in the Shopify app, then retry. " +
                    UNMAPPED_SYDNEY,
                customerId: undefined,
                packageIds: [],
            });
            expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
            expect(customers.upsertFromExternalOrder).not.toHaveBeenCalled();
            expect(
                query.mock.calls.some(([s]) => s.includes('FROM warehouse')),
            ).toBe(false);
        });

        it('names a location from its stored mapping when the event has no name', async () => {
            state.mappings = [
                mapping('loc-syd', 'Sydney (stored)', 'unmapped'),
            ];

            const outcome = await processor.process(
                grouped({}, [
                    group('fo-2', 'loc-syd', null, [
                        { line_item_id: 'li-2', quantity: 1 },
                    ]),
                ]),
            );

            expect(outcome).toMatchObject({
                error: expect.stringContaining(
                    "Shopify location 'Sydney (stored)' isn't mapped",
                ) as unknown,
            });
        });

        it('skips pickup, no-delivery and not-delivered groups, and the event when nothing is left', async () => {
            state.mappings = [mapping('loc-syd', 'Sydney DC', 'not_delivered')];

            const outcome = await processor.process(
                grouped({}, [
                    group(
                        'fo-1',
                        'loc-mel',
                        'Melbourne DC',
                        [{ line_item_id: 'li-1', quantity: 2 }],
                        { delivery_method: 'pickup' },
                    ),
                    group(
                        'fo-3',
                        'loc-mel',
                        'Melbourne DC',
                        [{ line_item_id: 'li-1', quantity: 2 }],
                        { delivery_method: 'none' },
                    ),
                    group('fo-2', 'loc-syd', 'Sydney DC', [
                        { line_item_id: 'li-2', quantity: 1 },
                    ]),
                ]),
            );

            expect(outcome).toEqual({
                status: 'skipped',
                error:
                    "The items from Shopify location 'Melbourne DC' are picked up. " +
                    "The items from Shopify location 'Melbourne DC' are not delivered. " +
                    "Shopify location 'Sydney DC' is not delivered by Hikyaku.",
            });
            expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
            expect(packages.createMany).not.toHaveBeenCalled();
        });

        it('processes a local-delivery group alongside a pickup one', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
            ];

            const outcome = await processor.process(
                grouped({}, [
                    group(
                        'fo-1',
                        'loc-mel',
                        'Melbourne DC',
                        [{ line_item_id: 'li-1', quantity: 2 }],
                        { delivery_method: 'local', total_weight_grams: 750 },
                    ),
                    group(
                        'fo-2',
                        'loc-syd',
                        'Sydney DC',
                        [{ line_item_id: 'li-2', quantity: 1 }],
                        { delivery_method: 'pickup' },
                    ),
                ]),
            );

            expect(outcome).toEqual({
                status: 'processed',
                customerId: 'cust-recipient',
                packageIds: ['pkg-1'],
            });
            expect(specs()).toEqual([
                expect.objectContaining({
                    warehouseId: 'wh-mel',
                    weightKg: 0.75,
                }),
            ]);
        });

        it('needs attention for an ungeocodable address, keeping the packages groups already have', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
                mapping('loc-syd', 'Sydney DC', 'warehouse', SYDNEY),
            ];
            state.packages = [
                {
                    id: 'pkg-mel',
                    to_customer: 'cust-old',
                    external_fulfillment_id: 'fo-1',
                },
            ];
            geocoder.geocodeAddress.mockRejectedValue(
                new UngeocodableAddressError('Could not find it.'),
            );

            const outcome = await processor.process(grouped());

            expect(outcome).toEqual({
                status: 'needs_attention',
                error: 'Could not find it.',
                customerId: 'cust-old',
                packageIds: ['pkg-mel'],
            });
            expect(packages.createMany).not.toHaveBeenCalled();
            expect(ledgerUpdates(query)[0]).toEqual([
                'ledger-1',
                'needs_attention',
                'cust-old',
                'pkg-mel',
                'Could not find it.',
            ]);
        });

        it('rethrows a geocoder outage after linking what exists, so the worker retries it', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
            ];
            const down = new Error('Photon timed out');
            geocoder.geocodeAddress.mockRejectedValue(down);

            await expect(processor.process(grouped())).rejects.toBe(down);
            expect(ledgerUpdates(query)).toHaveLength(0);
        });

        it('resolves a lost race for one group to its winner, assigning only what it made', async () => {
            state.mappings = [
                mapping('loc-mel', 'Melbourne DC', 'warehouse', MELBOURNE),
                mapping('loc-syd', 'Sydney DC', 'warehouse', SYDNEY),
            ];
            const create = packages.createMany.getMockImplementation()!;
            packages.createMany
                .mockImplementationOnce(create)
                .mockImplementationOnce(() => {
                    state.packages.push({
                        id: 'pkg-winner',
                        to_customer: 'cust-w',
                        external_fulfillment_id: 'fo-2',
                    });
                    return Promise.reject(
                        Object.assign(new Error('dup'), { code: '23505' }),
                    );
                });

            const outcome = await processor.process(grouped());

            expect(outcome).toMatchObject({
                status: 'processed',
                packageIds: ['pkg-1', 'pkg-winner'],
            });
            expect(links(query)).toEqual([
                ['ledger-1', ['pkg-winner'], ['fo-2']],
            ]);
            expect(packages.assignCreated).toHaveBeenCalledWith('org-1', [
                'pkg-1',
            ]);
        });

        it('needs attention when the event has no shop domain to match locations on', async () => {
            const p = groupedPayload();
            p.source.shop_domain = '  ';

            const outcome = await processor.process(event({ payload: p }));

            expect(outcome).toMatchObject({
                status: 'needs_attention',
                error: 'The order has no shop domain, so its Shopify locations cannot be matched to Hikyaku warehouses. Send source.shop_domain, then retry.',
            });
            expect(
                query.mock.calls.some(([s]) =>
                    s.includes('integration_location_mapping'),
                ),
            ).toBe(false);
        });

        it('matches the shop domain the way the mapping stores it', async () => {
            const p = groupedPayload();
            p.source.shop_domain = ' Hikyaku.MyShopify.com ';

            await processor.process(event({ payload: p }));

            const [, params] = query.mock.calls.find(([s]) =>
                s.includes('FROM public.integration_location_mapping'),
            )!;
            expect(params![2]).toBe('hikyaku.myshopify.com');
        });
    });
});

describe('weightKg', () => {
    const withOrder = (order: Record<string, unknown>) =>
        payload({ order: { id: 'o', name: '#1', ...order } });

    it('uses the order total when there is one', () => {
        expect(weightKg(withOrder({ total_weight_grams: 2500 }))).toBe(2.5);
    });

    it('sums the shippable line items when the total is missing or zero', () => {
        const order = withOrder({
            total_weight_grams: 0,
            line_items: [
                { grams: 300, quantity: 2, requires_shipping: true },
                { grams: 5000, quantity: 1, requires_shipping: false },
            ],
        });
        expect(weightKg(order)).toBe(0.6);
    });

    it('defaults to 1 kg when nothing weighs anything', () => {
        expect(weightKg(withOrder({ total_weight_grams: null }))).toBe(1);
        expect(
            weightKg(
                withOrder({ total_weight_grams: null, line_items: undefined }),
            ),
        ).toBe(1);
    });
});

describe('groupWeightKg', () => {
    const order = payload({
        order: {
            id: 'o',
            name: '#1',
            line_items: [
                { id: 'a', grams: 300, quantity: 5, requires_shipping: true },
                { id: 'b', grams: 5000, quantity: 1, requires_shipping: false },
            ],
        },
    });

    it('uses the group total when there is one', () => {
        expect(
            groupWeightKg(
                order,
                group('g', 'l', null, [], { total_weight_grams: 900 }),
            ),
        ).toBe(0.9);
    });

    it('sums the group’s own quantity of each shippable line item', () => {
        expect(
            groupWeightKg(
                order,
                group('g', 'l', null, [
                    { line_item_id: 'a', quantity: 2 },
                    { line_item_id: 'b', quantity: 1 },
                ]),
            ),
        ).toBe(0.6);
    });

    it('defaults to 1 kg when nothing in the group weighs anything', () => {
        expect(
            groupWeightKg(
                order,
                group('g', 'l', null, [{ line_item_id: 'b', quantity: 1 }], {
                    total_weight_grams: 0,
                }),
            ),
        ).toBe(1);
    });
});

describe('platformLabel', () => {
    it('reads a connector slug as a name', () => {
        expect(platformLabel('shopify')).toBe('Shopify');
        expect(platformLabel('big-commerce')).toBe('Big Commerce');
    });
});
