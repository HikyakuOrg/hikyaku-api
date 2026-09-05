import {
    Body,
    Controller,
    Delete,
    HttpCode,
    HttpStatus,
    Patch,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { DeactivateUsersDto } from './dto/deactivate-users.dto';
import { ReactivateUsersDto } from './dto/reactivate-users.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import {
    CreateUserResultDto,
    DeactivateUsersResultDto,
    ReactivateUsersResultDto,
    UpdateUserRoleResultDto,
} from './dto/user-results.dto';
import { UsersService } from './users.service';

/**
 * Team-member provisioning. Every route is org-scoped: PermissionGuard runs
 * without @SkipOrgContext, so X-Organisation-Slug is required on all four —
 * membership and permission rows are written against the org it resolves.
 */
@ApiTags('users')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/users')
@UseGuards(PermissionGuard)
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('team_members.add')
    @ApiOperation({
        summary: 'Invite a user into the organisation.',
        description:
            'Sends a Supabase invitation email, then writes the membership, ' +
            'permission grants and — for the Driver role — the driver profile in ' +
            'one transaction. If that transaction fails the auth user is deleted ' +
            'again, so a failed call leaves nothing behind. As with invitations, ' +
            'the caller cannot grant permissions they do not themselves hold.',
    })
    @ApiCreatedResponse({ type: CreateUserResultDto })
    createUser(
        @Body() dto: CreateUserDto,
        @Req() req: Request & { user: { id: string }; organisationId: string },
    ): Promise<CreateUserResultDto> {
        return this.usersService.createUser(
            dto,
            req.user.id,
            req.organisationId,
        );
    }

    @Delete()
    @HttpCode(HttpStatus.OK)
    @RequirePermission('team_members.delete')
    @ApiOperation({
        summary: 'Deactivate users.',
        description:
            'Bans each account for ~100 years and revokes its refresh tokens, ' +
            'preserving all associated data — nothing is deleted. Users are ' +
            'processed independently, so a 200 can still report failures: check ' +
            '`failed`. Callers cannot deactivate themselves, and accounts holding ' +
            'every permission are refused.',
    })
    @ApiOkResponse({ type: DeactivateUsersResultDto })
    deactivateUsers(
        @Body() dto: DeactivateUsersDto,
        @Req() req: Request & { user: { id: string }; organisationId: string },
    ): Promise<DeactivateUsersResultDto> {
        return this.usersService.deactivateUsers(
            dto,
            req.user.id,
            req.organisationId,
        );
    }

    @Patch('reactivate')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('team_members.edit')
    @ApiOperation({
        summary: 'Reactivate users.',
        description:
            'Lifts the deactivation ban. Partial success as above — check ' +
            '`failed`.',
    })
    @ApiOkResponse({ type: ReactivateUsersResultDto })
    reactivateUsers(
        @Body() dto: ReactivateUsersDto,
    ): Promise<ReactivateUsersResultDto> {
        return this.usersService.reactivateUsers(dto);
    }

    @Patch('role')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('team_members.edit')
    @ApiOperation({
        summary: 'Change a user’s role within the organisation.',
        description:
            'Replaces the role on the membership row. Permission grants are ' +
            'separate and are left untouched.',
    })
    @ApiOkResponse({ type: UpdateUserRoleResultDto })
    updateUserRole(
        @Body() dto: UpdateUserRoleDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<UpdateUserRoleResultDto> {
        return this.usersService.updateUserRole(
            dto.user_id,
            dto.role_name,
            req.organisationId,
        );
    }
}
