import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from 'src/database/database.module';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { AppPermission } from 'src/entities/app-permission.entity';
import { AppRole } from 'src/entities/app-role.entity';
import { Driver } from 'src/entities/driver.entity';
import { RolePermission } from 'src/entities/role-permission.entity';
import { TeamMember } from 'src/entities/team-member.entity';
import { UserPermission } from 'src/entities/user-permission.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            AppRole,
            AppPermission,
            RolePermission,
            TeamMember,
            Driver,
            UserPermission,
        ]),
    ],
    controllers: [UsersController],
    providers: [UsersService, PermissionGuard, Reflector],
})
export class UsersModule {}
