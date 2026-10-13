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
import { ShippingRateSettingsController } from './shipping-rate-settings.controller';
import { ShippingRateSettingsService } from './shipping-rate-settings.service';

const ORG_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const USER_ID = 'caller-id';

/** PermissionGuard's organisations lookup; see location-mappings.controller.spec.ts. */
function supabaseAs(granted: boolean) {
    const chain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
            data: {
                id: ORG_ID,
                trial_ends_at: null,
                subscription_status: null,
                team_members: [{ id: USER_ID }],
                user_permission: granted
                    ? [{ app_permission: { permission: 'granted' } }]
                    : [],
            },
        }),
    };
    return { chain, supabase: { from: jest.fn().mockReturnValue(chain) } };
}

type ServiceMock = { getView: jest.Mock; put: jest.Mock; remove: jest.Mock };

async function buildApp(
    supabase: { from: jest.Mock },
    service: ServiceMock,
): Promise<NestFastifyApplication> {
    const module: TestingModule = await Test.createTestingModule({
        controllers: [ShippingRateSettingsController],
        providers: [
            { provide: ShippingRateSettingsService, useValue: service },
            PermissionGuard,
            Reflector,
            { provide: SUPABASE_CLIENT, useValue: supabase },
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

describe('ShippingRateSettingsController (integration)', () => {
    let app: NestFastifyApplication;
    let service: ServiceMock;
    let chain: ReturnType<typeof supabaseAs>['chain'];

    const headers = {
        Authorization: 'Bearer t',
        'X-Organisation-Slug': 'acme',
    };
    const body = {
        platform: 'shopify',
        shop_domain: 'store.myshopify.com',
        shop_currency: 'AUD',
        enabled: true,
        service_ids: ['prod_1'],
        path: 'static',
        band_settings: { prod_1: { band_width: 5, max: 30 } },
    };

    async function start(granted = true): Promise<void> {
        const s = supabaseAs(granted);
        chain = s.chain;
        service = {
            getView: jest.fn().mockResolvedValue({ settings: {} }),
            put: jest.fn().mockResolvedValue({ enabled: true }),
            remove: jest.fn().mockResolvedValue(undefined),
        };
        app = await buildApp(s.supabase, service);
    }

    afterEach(async () => {
        await app?.close();
    });

    it('GET checks warehouse.view and passes the shop and currency through', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .get(
                '/api/v1/integrations/shipping-rates?platform=shopify&shop_domain=store.myshopify.com&currency=aud',
            )
            .set(headers);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { settings: {} } });
        expect(chain.eq).toHaveBeenCalledWith(
            'user_permission.app_permission.permission',
            'warehouse.view',
        );
        expect(service.getView).toHaveBeenCalledWith(
            ORG_ID,
            USER_ID,
            'shopify',
            'store.myshopify.com',
            'aud',
        );
    });

    it('GET 400s without a shop', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .get('/api/v1/integrations/shipping-rates?platform=shopify')
            .set(headers);
        expect(res.status).toBe(400);
    });

    it('PUT checks integrations.shipping_rates.write and returns 200', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .put('/api/v1/integrations/shipping-rates')
            .set(headers)
            .send(body);
        expect(res.status).toBe(200);
        expect(chain.eq).toHaveBeenCalledWith(
            'user_permission.app_permission.permission',
            'integrations.shipping_rates.write',
        );
        expect(service.put).toHaveBeenCalledWith(
            ORG_ID,
            USER_ID,
            expect.objectContaining({
                service_ids: ['prod_1'],
                band_settings: { prod_1: { band_width: 5, max: 30 } },
            }),
        );
    });

    it('PUT 403s without the permission', async () => {
        await start(false);
        const res = await request(app.getHttpServer())
            .put('/api/v1/integrations/shipping-rates')
            .set(headers)
            .send(body);
        expect(res.status).toBe(403);
        expect(service.put).not.toHaveBeenCalled();
    });

    it('PUT validates the body', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .put('/api/v1/integrations/shipping-rates')
            .set(headers)
            .send({ ...body, path: 'sideways', shop_currency: 'dollars' });
        expect(res.status).toBe(400);
    });

    it('DELETE returns 204', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .delete(
                '/api/v1/integrations/shipping-rates?platform=shopify&shop_domain=store.myshopify.com',
            )
            .set(headers);
        expect(res.status).toBe(204);
        expect(service.remove).toHaveBeenCalledWith(
            ORG_ID,
            'shopify',
            'store.myshopify.com',
        );
    });
});
