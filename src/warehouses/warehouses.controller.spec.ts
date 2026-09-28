import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { TokenVerifier } from 'src/auth/token-verifier.service';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

const ORG_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

const WAREHOUSE = {
    id: 'b6ef9918-3656-48f9-bf72-48dba1df4625',
    name: 'West Melbourne Depot',
    address: '1 Dock Road',
    city: 'West Melbourne',
    state: 'VIC',
    postcode: '3003',
    country: 'Australia',
    timezone: 'Australia/Melbourne',
    lon: 144.9407,
    lat: -37.8063,
};

function supabaseAs(granted: boolean) {
    const chain = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({
            data: {
                id: ORG_ID,
                trial_ends_at: null,
                subscription_status: null,
                team_members: [{ id: 'caller-id' }],
                user_permission: granted
                    ? [{ app_permission: { permission: 'warehouse.view' } }]
                    : [],
            },
        }),
    };
    return { chain, supabase: { from: jest.fn().mockReturnValue(chain) } };
}

async function buildApp(
    supabase: { from: jest.Mock },
    list: jest.Mock,
): Promise<NestFastifyApplication> {
    const module: TestingModule = await Test.createTestingModule({
        controllers: [WarehousesController],
        providers: [
            { provide: WarehousesService, useValue: { list } },
            PermissionGuard,
            Reflector,
            { provide: SUPABASE_CLIENT, useValue: supabase },
            {
                provide: TokenVerifier,
                useValue: {
                    verify: jest
                        .fn()
                        .mockResolvedValue({ id: 'caller-id', email: 'a@b.c' }),
                },
            },
        ],
    }).compile();

    const app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
}

describe('WarehousesController (integration)', () => {
    let app: NestFastifyApplication;

    afterEach(async () => {
        await app?.close();
    });

    it("lists the resolved organisation's warehouses, gated on warehouse.view", async () => {
        const { chain, supabase } = supabaseAs(true);
        const list = jest.fn().mockResolvedValue([WAREHOUSE]);
        app = await buildApp(supabase, list);

        const res = await request(app.getHttpServer())
            .get('/api/v1/warehouses')
            .set('Authorization', 'Bearer t')
            .set('X-Organisation-Slug', 'acme')
            .expect(200);

        expect(res.body).toEqual({ data: [WAREHOUSE] });
        expect(chain.eq).toHaveBeenCalledWith('slug', 'acme');
        expect(chain.eq).toHaveBeenCalledWith(
            'user_permission.app_permission.permission',
            'warehouse.view',
        );
        expect(list).toHaveBeenCalledWith(ORG_ID);
    });

    it('returns 403 without warehouse.view', async () => {
        const list = jest.fn();
        app = await buildApp(supabaseAs(false).supabase, list);

        await request(app.getHttpServer())
            .get('/api/v1/warehouses')
            .set('Authorization', 'Bearer t')
            .set('X-Organisation-Slug', 'acme')
            .expect(403);
        expect(list).not.toHaveBeenCalled();
    });

    it('returns 400 without X-Organisation-Slug', async () => {
        const list = jest.fn();
        app = await buildApp(supabaseAs(true).supabase, list);

        await request(app.getHttpServer())
            .get('/api/v1/warehouses')
            .set('Authorization', 'Bearer t')
            .expect(400);
        expect(list).not.toHaveBeenCalled();
    });
});
