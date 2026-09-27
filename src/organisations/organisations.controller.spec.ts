import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { TokenVerifier } from 'src/auth/token-verifier.service';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';

const ORG = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    slug: 'acme-logistics',
    name: 'Acme Logistics',
    orgType: 'company',
};

async function buildApp(options: {
    listForMember: jest.Mock;
    tokenVerifier: { verify: jest.Mock };
    supabase?: { from: jest.Mock };
}): Promise<NestFastifyApplication> {
    const module: TestingModule = await Test.createTestingModule({
        controllers: [OrganisationsController],
        providers: [
            {
                provide: OrganisationsService,
                useValue: { listForMember: options.listForMember },
            },
            PermissionGuard,
            Reflector,
            {
                provide: SUPABASE_CLIENT,
                useValue: options.supabase ?? { from: jest.fn() },
            },
            { provide: TokenVerifier, useValue: options.tokenVerifier },
        ],
    }).compile();

    const app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
}

describe('OrganisationsController (integration)', () => {
    let app: NestFastifyApplication;

    afterEach(async () => {
        await app?.close();
    });

    describe('GET /api/v1/organisations/me', () => {
        it('returns 401 without a valid token and never reaches the service', async () => {
            const listForMember = jest.fn();
            app = await buildApp({
                listForMember,
                tokenVerifier: {
                    verify: jest
                        .fn()
                        .mockRejectedValue(
                            new UnauthorizedException(
                                'Missing Authorization header',
                            ),
                        ),
                },
            });

            await request(app.getHttpServer())
                .get('/api/v1/organisations/me')
                .expect(401);
            expect(listForMember).not.toHaveBeenCalled();
        });

        it('needs no X-Organisation-Slug header and lists orgs the caller can post orders to', async () => {
            const listForMember = jest.fn().mockResolvedValue([ORG]);
            const supabase = { from: jest.fn() };
            app = await buildApp({
                listForMember,
                supabase,
                tokenVerifier: {
                    verify: jest.fn().mockResolvedValue({
                        id: 'u1',
                        email: 'u1@example.com',
                    }),
                },
            });

            const res = await request(app.getHttpServer())
                .get('/api/v1/organisations/me')
                .set('Authorization', 'Bearer valid-token')
                .expect(200);

            expect(res.body).toEqual([ORG]);
            expect(listForMember).toHaveBeenCalledWith(
                'u1',
                'integrations.orders.write',
            );
            // @SkipOrgContext: the guard never resolves a tenant.
            expect(supabase.from).not.toHaveBeenCalled();
        });

        it('returns an empty array when the caller has no qualifying memberships', async () => {
            app = await buildApp({
                listForMember: jest.fn().mockResolvedValue([]),
                tokenVerifier: {
                    verify: jest.fn().mockResolvedValue({
                        id: 'u1',
                        email: 'u1@example.com',
                    }),
                },
            });

            const res = await request(app.getHttpServer())
                .get('/api/v1/organisations/me')
                .set('Authorization', 'Bearer valid-token')
                .expect(200);

            expect(res.body).toEqual([]);
        });
    });
});
