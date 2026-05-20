import { Body, Controller, Delete, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { CreateUserDto } from './dto/create-user.dto';
import { DeactivateUsersDto } from './dto/deactivate-users.dto';
import { ReactivateUsersDto } from './dto/reactivate-users.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UsersService } from './users.service';

@Controller('api/v1/users')
@UseGuards(PermissionGuard)
export class UsersController {
    constructor(private readonly usersService: UsersService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('team_members.add')
    createUser(
        @Body() dto: CreateUserDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.usersService.createUser(dto, req.organisationId);
    }

    @Delete()
    @HttpCode(HttpStatus.OK)
    @RequirePermission('team_members.delete')
    deactivateUsers(
        @Body() dto: DeactivateUsersDto,
        @Req() req: Request & { user: { id: string }; organisationId: string },
    ) {
        return this.usersService.deactivateUsers(dto, req.user.id, req.organisationId);
    }

    @Patch('reactivate')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('team_members.edit')
    reactivateUsers(@Body() dto: ReactivateUsersDto) {
        return this.usersService.reactivateUsers(dto);
    }

    @Patch('role')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('team_members.edit')
    updateUserRole(
        @Body() dto: UpdateUserRoleDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.usersService.updateUserRole(dto.user_id, dto.role_name, req.organisationId);
    }
}
