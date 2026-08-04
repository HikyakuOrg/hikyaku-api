import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe, ExecutionContext } from '@nestjs/common';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request = require('supertest');
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { Reflector } from '@nestjs/core';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';

const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

const mockUsersService = {
    createUser: jest.fn(),
    deactivateUsers: jest.fn(),
    reactivateUsers: jest.fn(),
};

const bypassGuardValue = {
    canActivate(ctx: ExecutionContext) {
        ctx.switchToHttp().getRequest().user = { id: 'caller-id' };
        return true;
    },
};

async function buildApp(options: {
    bypass?: boolean;
    supabase?: {
        auth: { getUser: jest.Mock };
        from: jest.Mock;
    };
}): Promise<NestFastifyApplication> {
    const { bypass = false } = options;
    const supabase = options.supabase ?? {
        auth: { getUser: jest.fn() },
        from: jest.fn(),
    };

    const builder = Test.createTestingModule({
        controllers: [UsersController],
        providers: [
            { provide: UsersService, useValue: mockUsersService },
            PermissionGuard,
            Reflector,
            { provide: SUPABASE_CLIENT, useValue: supabase },
        ],
    });

    if (bypass) {
        builder.overrideGuard(PermissionGuard).useValue(bypassGuardValue);
    }

    const module: TestingModule = await builder.compile();
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


describe('UsersController (integration)', () => {
    let app: NestFastifyApplication;

    const validBody = {
        user_email: 'user@example.com',
        user_display_name: 'Test User',
        user_phone_number: '+61400000000',
        user_role: 'Admin',
    };

    afterEach(async () => {
        await app?.close();
        jest.clearAllMocks();
    });

    // =========================================================================
    // POST /api/v1/users
    // =========================================================================
    describe('POST /api/v1/users', () => {
        it('returns 401 when Authorization header is absent', async () => {
            const supabase = { auth: { getUser: jest.fn() }, from: jest.fn() };
            app = await buildApp({ supabase });
            return request(app.getHttpServer())
                .post('/api/v1/users')
                .send(validBody)
                .expect(401);
        });

        it('returns 403 when user lacks team_members.add permission', async () => {
            const chain = {
                select: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis(),
                maybeSingle: jest.fn().mockResolvedValue({ data: null }),
            };
            const supabase = {
                auth: {
                    getUser: jest
                        .fn()
                        .mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }),
                },
                from: jest.fn().mockReturnValue(chain),
            };
            app = await buildApp({ supabase });
            return request(app.getHttpServer())
                .post('/api/v1/users')
                .set('Authorization', 'Bearer valid-token')
                .send(validBody)
                .expect(403);
        });

        it('returns 400 when body fails validation (invalid email)', async () => {
            app = await buildApp({ bypass: true });
            return request(app.getHttpServer())
                .post('/api/v1/users')
                .send({ user_email: 'not-an-email' })
                .expect(400);
        });

        it('returns 201 with the created user on success', async () => {
            app = await buildApp({ bypass: true });
            mockUsersService.createUser.mockResolvedValueOnce({
                user_id: 'u1',
                user_email: 'user@example.com',
                user_display_name: 'Test User',
                user_phone_number: '+61400000000',
                user_role: 'Admin',
                user_permission: '[]',
                invited_at: null,
            });
            return request(app.getHttpServer())
                .post('/api/v1/users')
                .send(validBody)
                .expect(201)
                .expect((res) => {
                    expect(res.body.user_id).toBe('u1');
                    expect(res.body.user_email).toBe('user@example.com');
                });
        });
    });

    // =========================================================================
    // DELETE /api/v1/users
    // =========================================================================
    describe('DELETE /api/v1/users', () => {
        it('returns 401 when Authorization header is absent', async () => {
            app = await buildApp({});
            return request(app.getHttpServer())
                .delete('/api/v1/users')
                .send({ user_ids: [VALID_UUID] })
                .expect(401);
        });

        it('returns 400 when user_ids contains non-UUID values', async () => {
            app = await buildApp({ bypass: true });
            return request(app.getHttpServer())
                .delete('/api/v1/users')
                .send({ user_ids: ['not-a-uuid'] })
                .expect(400);
        });

        it('returns 200 with deactivation result on success', async () => {
            app = await buildApp({ bypass: true });
            mockUsersService.deactivateUsers.mockResolvedValueOnce({
                deactivated: [VALID_UUID],
                failed: [],
            });
            return request(app.getHttpServer())
                .delete('/api/v1/users')
                .send({ user_ids: [VALID_UUID] })
                .expect(200)
                .expect((res) => {
                    expect(res.body.deactivated).toEqual([VALID_UUID]);
                    expect(res.body.failed).toHaveLength(0);
                });
        });
    });

    // =========================================================================
    // PATCH /api/v1/users/reactivate
    // =========================================================================
    describe('PATCH /api/v1/users/reactivate', () => {
        it('returns 401 when Authorization header is absent', async () => {
            app = await buildApp({});
            return request(app.getHttpServer())
                .patch('/api/v1/users/reactivate')
                .send({ user_ids: [VALID_UUID] })
                .expect(401);
        });

        it('returns 400 when user_ids is empty', async () => {
            app = await buildApp({ bypass: true });
            return request(app.getHttpServer())
                .patch('/api/v1/users/reactivate')
                .send({ user_ids: [] })
                .expect(400);
        });

        it('returns 200 with reactivation result on success', async () => {
            app = await buildApp({ bypass: true });
            mockUsersService.reactivateUsers.mockResolvedValueOnce({
                reactivated: [VALID_UUID],
                failed: [],
            });
            return request(app.getHttpServer())
                .patch('/api/v1/users/reactivate')
                .send({ user_ids: [VALID_UUID] })
                .expect(200)
                .expect((res) => {
                    expect(res.body.reactivated).toEqual([VALID_UUID]);
                    expect(res.body.failed).toHaveLength(0);
                });
        });
    });
});
