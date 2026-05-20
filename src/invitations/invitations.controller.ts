import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { SkipOrgContext } from 'src/auth/decorators/skip-org-context.decorator';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { InvitationsService } from './invitations.service';

type AuthedUser = {
    id: string;
    email: string;
    email_confirmed_at?: string | null;
};

@Controller('api/v1/invitations')
@UseGuards(PermissionGuard)
export class InvitationsController {
    constructor(private readonly invitationsService: InvitationsService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('team_members.add')
    create(
        @Body() dto: CreateInvitationDto,
        @Req() req: Request & { user: AuthedUser; organisationId: string },
    ) {
        return this.invitationsService.createInvitation(
            dto,
            { id: req.user.id, email: req.user.email },
            req.organisationId,
        );
    }

    @Get('pending')
    @SkipOrgContext()
    listPending(@Req() req: Request & { user: AuthedUser }) {
        return this.invitationsService.listPendingFor(req.user.email);
    }

    @Post(':id/accept')
    @HttpCode(HttpStatus.OK)
    @SkipOrgContext()
    accept(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Req() req: Request & { user: AuthedUser },
    ) {
        return this.invitationsService.accept(id, req.user);
    }

    @Post(':id/decline')
    @HttpCode(HttpStatus.OK)
    @SkipOrgContext()
    decline(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Req() req: Request & { user: AuthedUser },
    ) {
        return this.invitationsService.decline(id, req.user);
    }
}
