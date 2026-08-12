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
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import {
    ApiAuthErrors,
    ApiConflict,
    ApiGuardErrors,
    ApiNotFound,
} from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { SkipOrgContext } from 'src/auth/decorators/skip-org-context.decorator';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import {
    AcceptInvitationResultDto,
    CreateInvitationResultDto,
    DeclineInvitationResultDto,
    PendingInvitationDto,
} from './dto/invitation-results.dto';
import { InvitationsService } from './invitations.service';

type AuthedUser = {
    id: string;
    email: string;
    email_confirmed_at?: string | null;
};

/**
 * Only the create route is org-scoped. The other three are @SkipOrgContext by
 * necessity — an invitee acts on an invitation before they are a member of the
 * organisation, so there is no tenant to resolve. The tenant header is therefore
 * declared per route rather than on the controller.
 */
@ApiTags('invitations')
@ApiBearerAuth('bearer')
@Controller('api/v1/invitations')
@UseGuards(PermissionGuard)
export class InvitationsController {
    constructor(private readonly invitationsService: InvitationsService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('team_members.add')
    @ApiOperation({
        summary: 'Invite someone to the active organisation.',
        description:
            'The caller cannot grant permissions they do not themselves hold. ' +
            'Re-inviting an address that already has an outstanding invitation ' +
            'updates that invitation in place rather than creating a second. The ' +
            'email is sent best-effort after the row is committed, so a 201 ' +
            'confirms the invitation exists, not that it was delivered.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiCreatedResponse({ type: CreateInvitationResultDto })
    @ApiConflict('That address is already a member of the organisation.')
    create(
        @Body() dto: CreateInvitationDto,
        @Req() req: Request & { user: AuthedUser; organisationId: string },
    ): Promise<CreateInvitationResultDto> {
        return this.invitationsService.createInvitation(
            dto,
            { id: req.user.id, email: req.user.email },
            req.organisationId,
        );
    }

    @Get('pending')
    @SkipOrgContext()
    @ApiOperation({
        summary: 'Invitations outstanding for the authenticated caller.',
        description:
            'Matched on the caller’s own email, newest first. Takes no tenant ' +
            'header — the caller is not yet a member of the inviting ' +
            'organisations. Empty array when there are none.',
    })
    @ApiAuthErrors()
    @ApiOkResponse({ type: [PendingInvitationDto] })
    listPending(@Req() req: Request & { user: AuthedUser }): Promise<PendingInvitationDto[]> {
        return this.invitationsService.listPendingFor(req.user.email);
    }

    @Post(':id/accept')
    @HttpCode(HttpStatus.OK)
    @SkipOrgContext()
    @ApiOperation({
        summary: 'Accept an invitation and join the organisation.',
        description:
            'Claims the invitation atomically, then writes the membership and ' +
            'copies its permission grants. Idempotent against a repeated call: ' +
            'the second attempt finds nothing pending and 404s. The caller must ' +
            'have a verified email address.',
    })
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiAuthErrors()
    @ApiOkResponse({ type: AcceptInvitationResultDto })
    @ApiForbiddenResponse({
        description: 'The caller’s email address is not verified yet.',
        type: ApiErrorDto,
    })
    @ApiNotFound(
        'No pending invitation with this id for the caller’s email — unknown, ' +
            'already decided, or addressed to someone else.',
    )
    accept(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Req() req: Request & { user: AuthedUser },
    ): Promise<AcceptInvitationResultDto> {
        return this.invitationsService.accept(id, req.user);
    }

    @Post(':id/decline')
    @HttpCode(HttpStatus.OK)
    @SkipOrgContext()
    @ApiOperation({
        summary: 'Decline an invitation.',
        description:
            'Marks it declined without joining. Like accept, a second call on the ' +
            'same invitation 404s rather than succeeding again.',
    })
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiAuthErrors()
    @ApiOkResponse({ type: DeclineInvitationResultDto })
    @ApiNotFound(
        'No pending invitation with this id for the caller’s email — unknown, ' +
            'already decided, or addressed to someone else.',
    )
    decline(
        @Param('id', new ParseUUIDPipe()) id: string,
        @Req() req: Request & { user: AuthedUser },
    ): Promise<DeclineInvitationResultDto> {
        return this.invitationsService.decline(id, req.user);
    }
}
