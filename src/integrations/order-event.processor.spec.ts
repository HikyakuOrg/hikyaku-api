import { DataSource } from 'typeorm';
import { CustomersService } from 'src/customers/customers.service';
import { PackagesService } from 'src/packages/packages.service';
import type {
    OrderDeliveryAddressDto,
    OrderEventDto,
} from './dto/order-event.dto';
import {
    OrderEventProcessor,
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

const WAREHOUSE = {
    id: 'wh-1',
    warehouse_name: 'Docklands',
    warehouse_address: '1 Depot Rd',
    warehouse_city: 'Docklands',
    warehouse_state: 'VIC',
    warehouse_zipcode: '3008',
    warehouse_country: 'AU',
    lon: 144.94,
    lat: -37.82,
};

describe('OrderEventProcessor', () => {
    let state: {
        existingPackage: { id: string; to_customer: string } | null;
        warehouse: typeof WAREHOUSE | null;
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

    /** Params of every ledger UPDATE sent through `mock`. */
    const ledgerUpdates = (mock: QueryMock): unknown[][] =>
        mock.mock.calls
            .filter(([sql]) =>
                sql.includes('UPDATE public.integration_order_event'),
            )
            .map(([, params]) => params ?? []);

    beforeEach(() => {
        state = { existingPackage: null, warehouse: WAREHOUSE };
        query = jest.fn((sql: string): Promise<unknown> => {
            if (sql.includes('FROM packages')) {
                return Promise.resolve(
                    state.existingPackage ? [state.existingPackage] : [],
                );
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
            upsertFromExternalOrder: jest
                .fn<
                    Promise<string>,
                    Parameters<CustomersService['upsertFromExternalOrder']>
                >()
                .mockResolvedValueOnce('cust-recipient')
                .mockResolvedValueOnce('cust-sender'),
        };
        packages = {
            createMany: jest
                .fn<
                    Promise<string[]>,
                    Parameters<PackagesService['createMany']>
                >()
                .mockResolvedValue(['pkg-1']),
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

    it('turns a paid order into a customer and a package, links the ledger row on the same transaction, then assigns', async () => {
        const outcome = await processor.process(event());

        expect(outcome).toEqual({
            status: 'processed',
            customerId: 'cust-recipient',
            packageId: 'pkg-1',
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

        // The sender is the store, at its warehouse.
        const [, sender, senderExternal] =
            customers.upsertFromExternalOrder.mock.calls[1];
        expect(sender).toMatchObject({
            name: 'hikyaku.myshopify.com (Docklands)',
            phone: null,
            email: null,
            address: { lon: 144.94, lat: -37.82, street: '1 Depot Rd' },
        });
        expect(senderExternal).toBeNull();

        const [txRunner, pkgOrg, specs] = packages.createMany.mock.calls[0];
        expect(txRunner).toBe(runner);
        expect(pkgOrg).toBe('org-1');
        expect(specs).toEqual([
            {
                warehouseId: 'wh-1',
                fromCustomerId: 'cust-sender',
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
                },
            },
        ]);

        const [linked] = ledgerUpdates(runner.query);
        expect(linked).toEqual([
            'ledger-1',
            'processed',
            'cust-recipient',
            'pkg-1',
            null,
        ]);
        expect(runner.commitTransaction).toHaveBeenCalled();
        expect(ledgerUpdates(query)).toHaveLength(0);

        expect(packages.assignCreated).toHaveBeenCalledWith('org-1', ['pkg-1']);
    });

    it('still reports processed when assignment throws: the package is committed', async () => {
        packages.assignCreated.mockRejectedValue(new Error('lock timeout'));
        await expect(processor.process(event())).resolves.toMatchObject({
            status: 'processed',
            packageId: 'pkg-1',
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
        state.existingPackage = { id: 'pkg-old', to_customer: 'cust-old' };

        const outcome = await processor.process(event());

        expect(outcome).toEqual({
            status: 'processed',
            customerId: 'cust-old',
            packageId: 'pkg-old',
        });
        expect(ledgerUpdates(query)).toHaveLength(1);
        expect(geocoder.geocodeAddress).not.toHaveBeenCalled();
        expect(packages.createMany).not.toHaveBeenCalled();
        expect(packages.assignCreated).not.toHaveBeenCalled();
    });

    it('resolves a lost race for the same order to the winner’s package', async () => {
        packages.createMany.mockImplementation(() => {
            state.existingPackage = { id: 'pkg-winner', to_customer: 'cust-w' };
            return Promise.reject(
                Object.assign(new Error('dup'), { code: '23505' }),
            );
        });

        const outcome = await processor.process(event());

        expect(outcome).toEqual({
            status: 'processed',
            customerId: 'cust-w',
            packageId: 'pkg-winner',
        });
        expect(runner.rollbackTransaction).toHaveBeenCalled();
        expect(runner.release).toHaveBeenCalled();
        expect(ledgerUpdates(query)[0][3]).toBe('pkg-winner');
        expect(packages.assignCreated).not.toHaveBeenCalled();
    });

    it('rethrows a 23505 when no winner can be found, and any other insert error', async () => {
        const dup = Object.assign(new Error('dup'), { code: '23505' });
        packages.createMany.mockRejectedValueOnce(dup);
        await expect(processor.process(event())).rejects.toBe(dup);

        customers.upsertFromExternalOrder
            .mockResolvedValueOnce('cust-recipient')
            .mockResolvedValueOnce('cust-sender');
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
        expect(customers.upsertFromExternalOrder.mock.calls[0][1].name).toBe(
            'Acme Pty Ltd',
        );

        customers.upsertFromExternalOrder
            .mockResolvedValueOnce('cust-recipient')
            .mockResolvedValueOnce('cust-sender');
        p.delivery.address!.company = null;
        await processor.process(event({ payload: p }));
        expect(customers.upsertFromExternalOrder.mock.calls[2][1].name).toBe(
            'Order #1001',
        );
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
        expect(customers.upsertFromExternalOrder.mock.calls[1][1].name).toBe(
            'shopify (Docklands)',
        );
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
