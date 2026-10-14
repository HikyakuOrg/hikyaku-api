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
import { StaticRatesController } from './static-rates.controller';
import { StaticRatesService } from './static-rates.service';

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

const PLAN = {
    currency: 'AUD',
    rates: [],
    coverage: { v: 1, w: [] },
    bbox_fallback: false,
};

describe('StaticRatesController (integration)', () => {
    let app: NestFastifyApplication;
    let plan: jest.Mock;
    let chain: ReturnType<typeof supabaseAs>['chain'];

    const headers = {
        Authorization: 'Bearer t',
        'X-Organisation-Slug': 'acme',
    };

    async function start(granted = true): Promise<void> {
        const s = supabaseAs(granted);
        chain = s.chain;
        plan = jest.fn().mockResolvedValue(PLAN);
        const module: TestingModule = await Test.createTestingModule({
            controllers: [StaticRatesController],
            providers: [
                { provide: StaticRatesService, useValue: { plan } },
                PermissionGuard,
                Reflector,
                { provide: SUPABASE_CLIENT, useValue: s.supabase },
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
        app = module.createNestApplication<NestFastifyApplication>(
            new FastifyAdapter(),
        );
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
        );
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
    }

    afterEach(async () => {
        await app?.close();
    });

    it('checks warehouse.view and returns the plan for the shop', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .get(
                '/api/v1/integrations/shipping-rates/static-plan?platform=shopify&shop_domain=store.myshopify.com',
            )
            .set(headers);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: PLAN });
        expect(chain.eq).toHaveBeenCalledWith(
            'user_permission.app_permission.permission',
            'warehouse.view',
        );
        expect(plan).toHaveBeenCalledWith(
            ORG_ID,
            'shopify',
            'store.myshopify.com',
        );
    });

    it('403s without the permission', async () => {
        await start(false);
        const res = await request(app.getHttpServer())
            .get(
                '/api/v1/integrations/shipping-rates/static-plan?platform=shopify&shop_domain=store.myshopify.com',
            )
            .set(headers);
        expect(res.status).toBe(403);
        expect(plan).not.toHaveBeenCalled();
    });

    it('400s on a bad platform', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .get(
                '/api/v1/integrations/shipping-rates/static-plan?platform=Shop%20ify&shop_domain=store.myshopify.com',
            )
            .set(headers);
        expect(res.status).toBe(400);
    });

    it('400s without a shop', async () => {
        await start();
        const res = await request(app.getHttpServer())
            .get(
                '/api/v1/integrations/shipping-rates/static-plan?platform=shopify',
            )
            .set(headers);
        expect(res.status).toBe(400);
        expect(plan).not.toHaveBeenCalled();
    });
});
