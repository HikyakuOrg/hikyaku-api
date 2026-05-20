import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from 'src/database/database.module';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { AppPermission } from 'src/entities/app-permission.entity';
import { AppRole } from 'src/entities/app-role.entity';
import { OrganisationInvitation } from 'src/entities/organisation-invitation.entity';
import { OrganisationInvitationPermission } from 'src/entities/organisation-invitation-permission.entity';
import { TeamMember } from 'src/entities/team-member.entity';
import { UserPermission } from 'src/entities/user-permission.entity';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            AppRole,
            AppPermission,
            TeamMember,
            UserPermission,
            OrganisationInvitation,
            OrganisationInvitationPermission,
        ]),
    ],
    controllers: [InvitationsController],
    providers: [InvitationsService, PermissionGuard, Reflector],
})
export class InvitationsModule { }
