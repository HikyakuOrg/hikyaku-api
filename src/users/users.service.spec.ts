import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
    BadRequestException,
    ForbiddenException,
    InternalServerErrorException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { DatabaseService } from 'src/database/database.service';
import { SUPABASE_CLIENT } from 'src/supabase/supabase.provider';
import { AppPermission } from 'src/entities/app-permission.entity';
import { AppRole } from 'src/entities/app-role.entity';
import { Driver } from 'src/entities/driver.entity';
import { TeamMember } from 'src/entities/team-member.entity';
import { UserPermission } from 'src/entities/user-permission.entity';

type MockQueryBuilder = {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
};

type MockRunner = {
    manager: {
        insert: jest.Mock;
        update: jest.Mock;
        createQueryBuilder: jest.Mock;
    };
    // Exposed for assertions — the service reaches the user_permission INSERT
    // through manager.createQueryBuilder().
    qb: MockQueryBuilder;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
};

function makeRunner(insertImpl?: jest.Mock): MockRunner {
    const qb: MockQueryBuilder = {
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
    };
    return {
        manager: {
            insert: insertImpl ?? jest.fn().mockResolvedValue(undefined),
            update: jest.fn().mockResolvedValue(undefined),
            createQueryBuilder: jest.fn().mockReturnValue(qb),
        },
        qb,
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
    };
}

const ORG_ID = '00000000-0000-0000-0000-0000000000aa';
const CALLER_ID = '00000000-0000-0000-0000-0000000000bb';

const VALID_DTO = {
    user_email: 'user@example.com',
    user_display_name: 'Test User',
    user_phone_number: '+61400000000',
    user_role: 'Admin',
    user_permission: [] as string[],
};

describe('UsersService', () => {
    let service: UsersService;
    let db: { query: jest.Mock; beginTransaction: jest.Mock };
    let appRoleRepo: { findOne: jest.Mock };
    let appPermissionRepo: { findBy: jest.Mock; count: jest.Mock };
    let userPermissionRepo: { findBy: jest.Mock; countBy: jest.Mock };
    let supabase: {
        auth: {
            admin: {
                inviteUserByEmail: jest.Mock;
                updateUserById: jest.Mock;
                deleteUser: jest.Mock;
                signOut: jest.Mock;
            };
        };
        storage: { from: jest.Mock };
    };

    beforeEach(async () => {
        db = { query: jest.fn(), beginTransaction: jest.fn() };
        appRoleRepo = {
            findOne: jest.fn().mockResolvedValue({ id: 1, name: 'Admin' }),
        };
        appPermissionRepo = {
            findBy: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        };
        userPermissionRepo = {
            findBy: jest.fn().mockResolvedValue([]),
            countBy: jest.fn().mockResolvedValue(0),
        };
        supabase = {
            auth: {
                admin: {
                    inviteUserByEmail: jest.fn(),
                    updateUserById: jest.fn(),
                    deleteUser: jest.fn(),
                    signOut: jest.fn(),
                },
            },
            storage: { from: jest.fn() },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UsersService,
                { provide: SUPABASE_CLIENT, useValue: supabase },
                { provide: DatabaseService, useValue: db },
                { provide: getRepositoryToken(AppRole), useValue: appRoleRepo },
                {
                    provide: getRepositoryToken(AppPermission),
                    useValue: appPermissionRepo,
                },
                {
                    provide: getRepositoryToken(UserPermission),
                    useValue: userPermissionRepo,
                },
            ],
        }).compile();

        service = module.get<UsersService>(UsersService);
    });

    /** Invite + phone update both succeed, returning `userId`. */
    function mockSuccessfulInvite(
        userId: string,
        invitedAt: string | null = null,
    ) {
        supabase.auth.admin.inviteUserByEmail.mockResolvedValueOnce({
            data: {
                user: {
                    id: userId,
                    email: 'user@example.com',
                    invited_at: invitedAt,
                },
            },
            error: null,
        });
        supabase.auth.admin.updateUserById.mockResolvedValueOnce({
            error: null,
        });
    }

    // ---------------------------------------------------------------------------
    // createUser
    // ---------------------------------------------------------------------------
    describe('createUser', () => {
        it('throws BadRequestException when role does not exist', async () => {
            appRoleRepo.findOne.mockResolvedValueOnce(null);
            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws BadRequestException for unknown permissions', async () => {
            appPermissionRepo.findBy.mockResolvedValueOnce([
                { id: 10, permission: 'team_members.view' },
            ]);
            await expect(
                service.createUser(
                    {
                        ...VALID_DTO,
                        user_permission: [
                            'team_members.view',
                            'team_members.add',
                        ],
                    },
                    CALLER_ID,
                    ORG_ID,
                ),
            ).rejects.toThrow('Unknown permission(s): team_members.add');
        });

        it('throws BadRequestException when email is already registered', async () => {
            supabase.auth.admin.inviteUserByEmail.mockResolvedValueOnce({
                data: null,
                error: { message: 'User already registered' },
            });
            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow(BadRequestException);
        });

        it('throws InternalServerErrorException when invite fails with unexpected error', async () => {
            supabase.auth.admin.inviteUserByEmail.mockResolvedValueOnce({
                data: null,
                error: { message: 'Internal server error' },
            });
            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow(InternalServerErrorException);
        });

        it('throws InternalServerErrorException when phone update fails', async () => {
            supabase.auth.admin.inviteUserByEmail.mockResolvedValueOnce({
                data: {
                    user: {
                        id: 'u1',
                        email: 'user@example.com',
                        invited_at: null,
                    },
                },
                error: null,
            });
            supabase.auth.admin.updateUserById.mockResolvedValueOnce({
                error: { message: 'Phone update failed' },
            });
            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow(InternalServerErrorException);
        });

        it('rolls back and throws InternalServerErrorException on a generic DB error', async () => {
            const runner = makeRunner(
                jest.fn().mockRejectedValueOnce(new Error('connection reset')),
            );
            db.beginTransaction.mockResolvedValueOnce(runner);
            mockSuccessfulInvite('u1');
            supabase.auth.admin.deleteUser.mockResolvedValueOnce({
                error: null,
            });

            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow(InternalServerErrorException);
            expect(runner.rollbackTransaction).toHaveBeenCalled();
        });

        it('throws BadRequestException on FK violation during DB write', async () => {
            const runner = makeRunner(
                jest
                    .fn()
                    .mockRejectedValueOnce(
                        new Error(
                            'violates foreign key constraint "team_members_role_id_fkey"',
                        ),
                    ),
            );
            db.beginTransaction.mockResolvedValueOnce(runner);
            mockSuccessfulInvite('u1');
            supabase.auth.admin.deleteUser.mockResolvedValueOnce({
                error: null,
            });

            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow(BadRequestException);
        });

        it('returns CreateUserResult on success', async () => {
            const runner = makeRunner();
            db.beginTransaction.mockResolvedValueOnce(runner);
            mockSuccessfulInvite('u1', '2026-01-01T00:00:00Z');

            const result = await service.createUser(
                VALID_DTO,
                CALLER_ID,
                ORG_ID,
            );

            expect(result.user_id).toBe('u1');
            expect(result.user_email).toBe('user@example.com');
            expect(runner.commitTransaction).toHaveBeenCalled();
            expect(runner.manager.insert).toHaveBeenCalledWith(TeamMember, {
                organisationId: ORG_ID,
                id: 'u1',
                roleId: 1,
            });
        });

        it('includes avatar upload URL when user_avatar is true', async () => {
            db.beginTransaction.mockResolvedValueOnce(makeRunner());
            mockSuccessfulInvite('u1');
            supabase.storage.from.mockReturnValue({
                createSignedUploadUrl: jest.fn().mockResolvedValue({
                    data: { signedUrl: 'https://storage.example.com/upload' },
                    error: null,
                }),
            });

            const result = await service.createUser(
                { ...VALID_DTO, user_avatar: true },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.user_avatar_upload_url).toBe(
                'https://storage.example.com/upload',
            );
        });

        it('throws InternalServerErrorException when avatar URL generation fails', async () => {
            db.beginTransaction.mockResolvedValueOnce(makeRunner());
            mockSuccessfulInvite('u1');
            supabase.storage.from.mockReturnValue({
                createSignedUploadUrl: jest.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'Bucket not found' },
                }),
            });

            await expect(
                service.createUser(
                    { ...VALID_DTO, user_avatar: true },
                    CALLER_ID,
                    ORG_ID,
                ),
            ).rejects.toThrow(InternalServerErrorException);
        });

        it('creates Driver user and inserts driver metadata', async () => {
            const runner = makeRunner();
            appRoleRepo.findOne.mockResolvedValueOnce({
                id: 2,
                name: 'Driver',
            });
            db.beginTransaction.mockResolvedValueOnce(runner);
            mockSuccessfulInvite('u2');

            const result = await service.createUser(
                {
                    ...VALID_DTO,
                    user_role: 'Driver',
                    user_metadata: {
                        driver_license: 'DL123',
                        license_expiry: '2030-01-01',
                        country_of_issue: 'AU',
                        driver_under_probation: false,
                        license_type: 'C',
                    },
                },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.user_id).toBe('u2');
            expect(runner.manager.insert).toHaveBeenCalledWith(
                Driver,
                expect.objectContaining({ id: 'u2', driverLicense: 'DL123' }),
            );
        });

        it('inserts permission rows when user_permission is non-empty', async () => {
            const runner = makeRunner();
            appPermissionRepo.findBy.mockResolvedValueOnce([
                { id: 10, permission: 'packages.view' },
            ]);
            userPermissionRepo.findBy.mockResolvedValueOnce([
                { permissionId: 10 },
            ]);
            db.beginTransaction.mockResolvedValueOnce(runner);
            mockSuccessfulInvite('u3');

            const result = await service.createUser(
                { ...VALID_DTO, user_permission: ['packages.view'] },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.user_id).toBe('u3');
            expect(runner.qb.into).toHaveBeenCalledWith(UserPermission);
            expect(runner.qb.values).toHaveBeenCalledWith([
                { organisationId: ORG_ID, userId: 'u3', permissionId: 10 },
            ]);
        });

        it('logs error when orphaned auth user cleanup also fails after DB error', async () => {
            const runner = makeRunner(
                jest
                    .fn()
                    .mockRejectedValueOnce(new Error('constraint violation')),
            );
            db.beginTransaction.mockResolvedValueOnce(runner);
            mockSuccessfulInvite('u4');
            // Cleanup also fails
            supabase.auth.admin.deleteUser.mockResolvedValueOnce({
                error: { message: 'Auth service unavailable' },
            });

            await expect(
                service.createUser(VALID_DTO, CALLER_ID, ORG_ID),
            ).rejects.toThrow();
            expect(runner.rollbackTransaction).toHaveBeenCalled();
        });

        // -----------------------------------------------------------------------
        // Least privilege — mirrors InvitationsService.createInvitation. Without
        // it, team_members.add on its own is enough to mint an administrator.
        // -----------------------------------------------------------------------
        describe('least privilege', () => {
            const ESCALATING_DTO = {
                ...VALID_DTO,
                user_permission: ['packages.view', 'organisation.edit'],
            };

            beforeEach(() => {
                appPermissionRepo.findBy.mockResolvedValue([
                    { id: 10, permission: 'packages.view' },
                    { id: 11, permission: 'organisation.edit' },
                ]);
            });

            it('throws ForbiddenException when granting a permission the caller does not hold', async () => {
                // Caller holds packages.view but not organisation.edit.
                userPermissionRepo.findBy.mockResolvedValue([
                    { permissionId: 10 },
                ]);

                await expect(
                    service.createUser(ESCALATING_DTO, CALLER_ID, ORG_ID),
                ).rejects.toThrow(ForbiddenException);
                await expect(
                    service.createUser(ESCALATING_DTO, CALLER_ID, ORG_ID),
                ).rejects.toThrow(
                    'You cannot grant permissions you do not hold',
                );
            });

            it('throws ForbiddenException when the caller holds no permissions at all', async () => {
                userPermissionRepo.findBy.mockResolvedValueOnce([]);

                await expect(
                    service.createUser(ESCALATING_DTO, CALLER_ID, ORG_ID),
                ).rejects.toThrow(ForbiddenException);
            });

            it('rejects before inviting, so no auth user is left behind', async () => {
                userPermissionRepo.findBy.mockResolvedValueOnce([
                    { permissionId: 10 },
                ]);

                await expect(
                    service.createUser(ESCALATING_DTO, CALLER_ID, ORG_ID),
                ).rejects.toThrow(ForbiddenException);
                expect(
                    supabase.auth.admin.inviteUserByEmail,
                ).not.toHaveBeenCalled();
                expect(db.beginTransaction).not.toHaveBeenCalled();
                expect(supabase.auth.admin.deleteUser).not.toHaveBeenCalled();
            });

            it('scopes the caller grant lookup to the active organisation', async () => {
                userPermissionRepo.findBy.mockResolvedValueOnce([]);

                await expect(
                    service.createUser(ESCALATING_DTO, CALLER_ID, ORG_ID),
                ).rejects.toThrow(ForbiddenException);
                expect(userPermissionRepo.findBy).toHaveBeenCalledWith({
                    organisationId: ORG_ID,
                    userId: CALLER_ID,
                });
            });

            it('allows a grant set the caller fully holds', async () => {
                const runner = makeRunner();
                userPermissionRepo.findBy.mockResolvedValueOnce([
                    { permissionId: 10 },
                    { permissionId: 11 },
                ]);
                db.beginTransaction.mockResolvedValueOnce(runner);
                mockSuccessfulInvite('u5');

                const result = await service.createUser(
                    ESCALATING_DTO,
                    CALLER_ID,
                    ORG_ID,
                );

                expect(result.user_id).toBe('u5');
                expect(runner.commitTransaction).toHaveBeenCalled();
            });

            it('allows a strict subset of what the caller holds', async () => {
                const runner = makeRunner();
                appPermissionRepo.findBy.mockResolvedValue([
                    { id: 10, permission: 'packages.view' },
                ]);
                userPermissionRepo.findBy.mockResolvedValueOnce([
                    { permissionId: 10 },
                    { permissionId: 11 },
                ]);
                db.beginTransaction.mockResolvedValueOnce(runner);
                mockSuccessfulInvite('u6');

                const result = await service.createUser(
                    { ...VALID_DTO, user_permission: ['packages.view'] },
                    CALLER_ID,
                    ORG_ID,
                );

                expect(result.user_id).toBe('u6');
            });

            it('compares ids numerically — bigint columns come back as strings', async () => {
                const runner = makeRunner();
                // permission_id is bigint, so the driver hands the ids back as strings.
                userPermissionRepo.findBy.mockResolvedValueOnce([
                    { permissionId: '10' },
                    { permissionId: '11' },
                ]);
                db.beginTransaction.mockResolvedValueOnce(runner);
                mockSuccessfulInvite('u7');

                const result = await service.createUser(
                    ESCALATING_DTO,
                    CALLER_ID,
                    ORG_ID,
                );

                expect(result.user_id).toBe('u7');
            });

            it('skips the grant lookup when no permissions are requested', async () => {
                db.beginTransaction.mockResolvedValueOnce(makeRunner());
                mockSuccessfulInvite('u8');

                await service.createUser(VALID_DTO, CALLER_ID, ORG_ID);

                expect(userPermissionRepo.findBy).not.toHaveBeenCalled();
            });

            it('rejects unknown permissions before checking the caller grants', async () => {
                appPermissionRepo.findBy.mockResolvedValueOnce([
                    { id: 10, permission: 'packages.view' },
                ]);

                await expect(
                    service.createUser(
                        {
                            ...VALID_DTO,
                            user_permission: ['packages.view', 'nope.nope'],
                        },
                        CALLER_ID,
                        ORG_ID,
                    ),
                ).rejects.toThrow(BadRequestException);
                expect(userPermissionRepo.findBy).not.toHaveBeenCalled();
            });
        });
    });

    // ---------------------------------------------------------------------------
    // deactivateUsers
    // ---------------------------------------------------------------------------
    describe('deactivateUsers', () => {
        const UID = '00000000-0000-0000-0000-000000000001';

        it('returns deactivated list with empty failed on success', async () => {
            appPermissionRepo.count.mockResolvedValue(5);
            userPermissionRepo.countBy.mockResolvedValue(2);
            supabase.auth.admin.updateUserById.mockResolvedValue({
                error: null,
            });
            supabase.auth.admin.signOut.mockResolvedValue({});

            const result = await service.deactivateUsers(
                { user_ids: [UID] },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.deactivated).toEqual([UID]);
            expect(result.failed).toHaveLength(0);
        });

        it('adds to failed when user tries to deactivate their own account', async () => {
            const result = await service.deactivateUsers(
                { user_ids: [UID] },
                UID,
                ORG_ID,
            );

            expect(result.failed).toHaveLength(1);
            expect(result.failed[0].reason).toContain(
                'Cannot deactivate your own account',
            );
        });

        it('refuses to deactivate an account holding every permission', async () => {
            appPermissionRepo.count.mockResolvedValue(5);
            userPermissionRepo.countBy.mockResolvedValue(5);

            const result = await service.deactivateUsers(
                { user_ids: [UID] },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.failed).toHaveLength(1);
            expect(result.failed[0].reason).toContain(
                'Admin accounts cannot be deactivated',
            );
            expect(supabase.auth.admin.updateUserById).not.toHaveBeenCalled();
        });

        it('adds to failed when the ban call fails', async () => {
            appPermissionRepo.count.mockResolvedValue(5);
            userPermissionRepo.countBy.mockResolvedValue(2);
            supabase.auth.admin.updateUserById.mockResolvedValue({
                error: { message: 'User not found' },
            });

            const result = await service.deactivateUsers(
                { user_ids: [UID] },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.failed).toHaveLength(1);
            expect(result.deactivated).toHaveLength(0);
        });

        it('processes multiple users independently, collecting partial results', async () => {
            const UID2 = '00000000-0000-0000-0000-000000000002';
            appPermissionRepo.count.mockResolvedValue(5);
            userPermissionRepo.countBy.mockResolvedValue(2);
            supabase.auth.admin.updateUserById
                .mockResolvedValueOnce({ error: null })
                .mockResolvedValueOnce({ error: { message: 'Not found' } });
            supabase.auth.admin.signOut.mockResolvedValue({});

            const result = await service.deactivateUsers(
                { user_ids: [UID, UID2] },
                CALLER_ID,
                ORG_ID,
            );

            expect(result.deactivated).toHaveLength(1);
            expect(result.failed).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------------------
    // reactivateUsers
    // ---------------------------------------------------------------------------
    describe('reactivateUsers', () => {
        const UID = '00000000-0000-0000-0000-000000000001';

        it('returns reactivated list with empty failed on success', async () => {
            supabase.auth.admin.updateUserById.mockResolvedValue({
                error: null,
            });

            const result = await service.reactivateUsers({ user_ids: [UID] });

            expect(result.reactivated).toEqual([UID]);
            expect(result.failed).toHaveLength(0);
        });

        it('adds to failed when the unban call fails', async () => {
            supabase.auth.admin.updateUserById.mockResolvedValue({
                error: { message: 'User not found' },
            });

            const result = await service.reactivateUsers({ user_ids: [UID] });

            expect(result.failed).toHaveLength(1);
            expect(result.reactivated).toHaveLength(0);
        });
    });
});
