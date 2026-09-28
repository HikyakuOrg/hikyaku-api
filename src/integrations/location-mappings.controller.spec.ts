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
import { LocationMappingsController } from './location-mappings.controller';
import { LocationMappingsService } from './location-mappings.service';

const ORG_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const USER_ID = 'caller-id';
const WAREHOUSE = 'b6ef9918-3656-48f9-bf72-48dba1df4625';

/**
 * The organisations lookup PermissionGuard makes, answering as a member of
 * ORG_ID who holds the requested permission, or (`granted: false`) as one who
 * does not, which is how PostgREST's filtered embed comes back.
 */
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

async function buildApp(
    supabase: { from: jest.Mock },
    service: { list: jest.Mock; upsert: jest.Mock },
): Promise<NestFastifyApplication> {
    const module: TestingModule = await Test.createTestingModule({
        controllers: [LocationMappingsController],
        providers: [
            { provide: LocationMappingsService, useValue: service },
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

describe('LocationMappingsController (integration)', () => {
    let app: NestFastifyApplication;
    let service: { list: jest.Mock; upsert: jest.Mock };

    const body = {
        platform: 'shopify',
        shop_domain: 'store.myshopify.com',
        mark_missing_stale: true,
        locations: [
            {
                external_location_id: 'gid://shopify/Location/1',
                external_location_name: 'Melbourne',
                country_code: 'AU',
                mode: 'warehouse',
                warehouse_id: WAREHOUSE,
            },
            { external_location_id: 'gid://shopify/Location/2' },
        ],
    };

    beforeEach(() => {
        service = {
            list: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockResolvedValue([]),
        };
    });

    afterEach(async () => {
        await app?.close();
    });

    const put = () =>
        request(app.getHttpServer())
            .put('/api/v1/integrations/locations')
            .set('Authorization', 'Bearer t')
            .set('X-Organisation-Slug', 'acme');

    describe('GET /api/v1/integrations/locations', () => {
        it('lists the resolved organisation only, gated on warehouse.view', async () => {
            const { chain, supabase } = supabaseAs(true);
            app = await buildApp(supabase, service);

            const res = await request(app.getHttpServer())
                .get('/api/v1/integrations/locations')
                .query({
                    platform: 'shopify',
                    shop_domain: 'store.myshopify.com',
                })
                .set('Authorization', 'Bearer t')
                .set('X-Organisation-Slug', 'acme')
                .expect(200);

            expect(res.body).toEqual({ data: [] });
            expect(chain.eq).toHaveBeenCalledWith(
                'user_permission.app_permission.permission',
                'warehouse.view',
            );
            expect(service.list).toHaveBeenCalledWith(ORG_ID, {
                platform: 'shopify',
                shopDomain: 'store.myshopify.com',
            });
        });

        it('returns 400 for a platform that is not a slug', async () => {
            app = await buildApp(supabaseAs(true).supabase, service);

            await request(app.getHttpServer())
                .get('/api/v1/integrations/locations')
                .query({ platform: 'Shopify' })
                .set('Authorization', 'Bearer t')
                .set('X-Organisation-Slug', 'acme')
                .expect(400);
            expect(service.list).not.toHaveBeenCalled();
        });

        it('returns 400 without X-Organisation-Slug', async () => {
            app = await buildApp(supabaseAs(true).supabase, service);

            await request(app.getHttpServer())
                .get('/api/v1/integrations/locations')
                .set('Authorization', 'Bearer t')
                .expect(400);
            expect(service.list).not.toHaveBeenCalled();
        });
    });

    describe('PUT /api/v1/integrations/locations', () => {
        it('upserts for the resolved organisation as the caller, gated on integrations.locations.write', async () => {
            const { chain, supabase } = supabaseAs(true);
            app = await buildApp(supabase, service);

            await put().send(body).expect(200, { data: [] });

            expect(chain.eq).toHaveBeenCalledWith(
                'user_permission.app_permission.permission',
                'integrations.locations.write',
            );
            expect(service.upsert).toHaveBeenCalledWith(ORG_ID, USER_ID, body);
        });

        it('returns 403 without integrations.locations.write', async () => {
            app = await buildApp(supabaseAs(false).supabase, service);

            await put().send(body).expect(403);
            expect(service.upsert).not.toHaveBeenCalled();
        });

        it.each([
            ['an unknown mode', { mode: 'dropship' }],
            ['a warehouse_id that is not a uuid', { warehouse_id: 'wh-1' }],
            ['a three letter country code', { country_code: 'AUS' }],
            ['an unknown field', { priority: 1 }],
            ['no external_location_id', { external_location_id: '' }],
        ])('returns 400 for a location with %s', async (_label, patch) => {
            app = await buildApp(supabaseAs(true).supabase, service);

            await put()
                .send({
                    ...body,
                    locations: [{ ...body.locations[0], ...patch }],
                })
                .expect(400);
            expect(service.upsert).not.toHaveBeenCalled();
        });

        it('returns 400 for a platform that is not a slug', async () => {
            app = await buildApp(supabaseAs(true).supabase, service);

            await put()
                .send({ ...body, platform: 'Shopify Plus' })
                .expect(400);
            expect(service.upsert).not.toHaveBeenCalled();
        });

        it('returns 400 when locations is not an array', async () => {
            app = await buildApp(supabaseAs(true).supabase, service);

            await put()
                .send({ ...body, locations: body.locations[0] })
                .expect(400);
            expect(service.upsert).not.toHaveBeenCalled();
        });
    });
});
