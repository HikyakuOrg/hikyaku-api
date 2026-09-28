import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { TokenVerifier } from 'src/auth/token-verifier.service';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

const ORG_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const USER_ID = 'caller-id';

/**
 * The organisations lookup PermissionGuard makes, answering as a member of
 * ORG_ID who holds the requested permission; see
 * location-mappings.controller.spec.ts.
 */
function supabaseGranted() {
    const chain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
            data: {
                id: ORG_ID,
                trial_ends_at: null,
                subscription_status: null,
                team_members: [{ id: USER_ID }],
                user_permission: [
                    { app_permission: { permission: 'granted' } },
                ],
            },
        }),
    };
    return { from: jest.fn().mockReturnValue(chain) };
}

async function buildApp(service: {
    recordOrderEvent: jest.Mock;
}): Promise<NestFastifyApplication> {
    const module: TestingModule = await Test.createTestingModule({
        controllers: [IntegrationsController],
        providers: [
            { provide: IntegrationsService, useValue: service },
            PermissionGuard,
            Reflector,
            { provide: SUPABASE_CLIENT, useValue: supabaseGranted() },
            {
                provide: TokenVerifier,
                useValue: {
                    verify: jest
                        .fn()
                        .mockResolvedValue({ id: USER_ID, email: 'a@b.c' }),
                },
            },
        ],
    }).compile();

    const app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
    );
    app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
}

describe('IntegrationsController (integration)', () => {
    let app: NestFastifyApplication;
    let service: { recordOrderEvent: jest.Mock };

    const lineItem = (id: string) => ({
        id,
        title: `Item ${id}`,
        variant_title: null,
        sku: null,
        quantity: 2,
        price: '10.00',
        grams: 500,
        requires_shipping: true,
    });

    /** An order event as connectors sent it before fulfillment groups. */
    const body = {
        event: {
            id: 'evt-1',
            type: 'order.paid',
            occurred_at: '2026-09-10T00:00:00Z',
            api_version: '2025-01',
        },
        source: {
            platform: 'shopify',
            shop_domain: 'store.myshopify.com',
            app_version: '0.1.0',
        },
        order: {
            id: 'gid://shopify/Order/1',
            legacy_id: 1,
            name: '#1001',
            created_at: '2026-09-10T00:00:00Z',
            processed_at: null,
            currency: 'AUD',
            financial_status: 'paid',
            fulfillment_status: null,
            total_price: '40.00',
            subtotal_price: '40.00',
            total_shipping: '0.00',
            total_tax: null,
            note: null,
            tags: [],
            total_weight_grams: 2000,
            line_items: [lineItem('li-1'), lineItem('li-2')],
        },
        customer: {
            id: null,
            first_name: 'Ada',
            last_name: 'Lovelace',
            email: null,
            phone: null,
        },
        delivery: {
            required: true,
            recipient_name: 'Ada Lovelace',
            phone: null,
            email: null,
            address: null,
            latitude: null,
            longitude: null,
            shipping_method: null,
            instructions: null,
        },
    };

    const group = {
        id: 'fo-1',
        external_location_id: 'loc-1',
        external_location_name: 'Melbourne',
        delivery_method: 'shipping',
        line_items: [
            { line_item_id: 'li-1', quantity: 2 },
            { line_item_id: 'li-2', quantity: 1 },
        ],
        total_weight_grams: 1500,
    };

    beforeEach(async () => {
        service = {
            recordOrderEvent: jest.fn().mockResolvedValue({
                result: { id: 'ledger-1' },
                replayed: false,
            }),
        };
        app = await buildApp(service);
    });

    afterEach(async () => {
        await app?.close();
    });

    const post = () =>
        request(app.getHttpServer())
            .post('/api/v1/integrations/orders')
            .set('Authorization', 'Bearer t')
            .set('X-Organisation-Slug', 'acme')
            .set('Idempotency-Key', 'idem-1');

    /** The OrderEventDto the controller handed to the service. */
    const recorded = () =>
        (service.recordOrderEvent.mock.calls[0] as unknown[])[2] as Record<
            string,
            unknown
        >;

    describe('POST /api/v1/integrations/orders', () => {
        it('records an event without fulfillment_groups unchanged', async () => {
            await post().send(body).expect(201, { id: 'ledger-1' });

            const [orgId, key] = service.recordOrderEvent.mock.calls[0] as [
                string,
                string,
            ];
            expect(orgId).toBe(ORG_ID);
            expect(key).toBe('idem-1');
            expect(recorded().fulfillment_groups).toBeUndefined();
            // The ledger stores JSON.stringify(dto), so compare that form.
            expect(JSON.parse(JSON.stringify(recorded()))).toEqual(body);
        });

        it('records an event with an empty fulfillment_groups', async () => {
            await post()
                .send({ ...body, fulfillment_groups: [] })
                .expect(201);

            expect(recorded()).toEqual({
                ...body,
                fulfillment_groups: [],
            });
        });

        it('records fulfillment_groups that split the order across locations', async () => {
            const fulfillment_groups = [
                group,
                {
                    ...group,
                    id: 'fo-2',
                    external_location_id: 'loc-2',
                    external_location_name: null,
                    delivery_method: 'pickup',
                    line_items: [{ line_item_id: 'li-2', quantity: 1 }],
                    total_weight_grams: null,
                },
            ];

            await post()
                .send({ ...body, fulfillment_groups })
                .expect(201);

            expect(recorded()).toEqual({
                ...body,
                fulfillment_groups,
            });
        });

        it.each(['shipping', 'local', 'pickup', 'none'])(
            'accepts delivery_method %s',
            async (delivery_method) => {
                await post()
                    .send({
                        ...body,
                        fulfillment_groups: [{ ...group, delivery_method }],
                    })
                    .expect(201);
            },
        );

        it('returns 400 naming a line_item_id that is not in order.line_items', async () => {
            const res = await post()
                .send({
                    ...body,
                    fulfillment_groups: [
                        {
                            ...group,
                            line_items: [
                                { line_item_id: 'li-1', quantity: 1 },
                                { line_item_id: 'li-9', quantity: 1 },
                            ],
                        },
                    ],
                })
                .expect(400);

            expect(JSON.stringify(res.body)).toContain('unknown: li-9');
            expect(service.recordOrderEvent).not.toHaveBeenCalled();
        });

        it.each([
            ['an unknown delivery_method', { delivery_method: 'drone' }],
            ['no id', { id: '' }],
            ['no external_location_id', { external_location_id: '' }],
            ['an unknown field', { priority: 1 }],
            ['line_items that is not an array', { line_items: 'li-1' }],
            [
                'a zero quantity',
                { line_items: [{ line_item_id: 'li-1', quantity: 0 }] },
            ],
            [
                'a fractional quantity',
                { line_items: [{ line_item_id: 'li-1', quantity: 1.5 }] },
            ],
            [
                'an empty line_item_id',
                { line_items: [{ line_item_id: '', quantity: 1 }] },
            ],
            [
                'a total_weight_grams that is not a number',
                { total_weight_grams: '1500' },
            ],
        ])('returns 400 for a group with %s', async (_label, patch) => {
            await post()
                .send({ ...body, fulfillment_groups: [{ ...group, ...patch }] })
                .expect(400);
            expect(service.recordOrderEvent).not.toHaveBeenCalled();
        });

        it('returns 400 when fulfillment_groups is not an array', async () => {
            await post()
                .send({ ...body, fulfillment_groups: group })
                .expect(400);
            expect(service.recordOrderEvent).not.toHaveBeenCalled();
        });
    });
});
