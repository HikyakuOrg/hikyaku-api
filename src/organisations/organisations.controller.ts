import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiAuthErrors } from 'src/common/swagger/api-errors.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { AuthedUser } from 'src/auth/authed-user';
import { SkipOrgContext } from 'src/auth/decorators/skip-org-context.decorator';
import { MemberOrganisationDto } from './dto/member-organisation.dto';
import { OrganisationsService } from './organisations.service';

/**
 * The permission an organisation must grant the caller to be listed by
 * GET /organisations/me. Its only client today is a storefront connector
 * picking which organisation to forward orders to, and POST
 * /integrations/orders requires this permission — listing an org without it
 * would let the merchant pick one whose every order POST 403s.
 */
const ORDER_INGESTION_PERMISSION = 'integrations.orders.write';

@ApiTags('organisations')
@ApiBearerAuth('bearer')
@Controller('api/v1/organisations')
@UseGuards(PermissionGuard)
export class OrganisationsController {
    constructor(private readonly organisationsService: OrganisationsService) {}

    @Get('me')
    @SkipOrgContext()
    @ApiOperation({
        summary: 'Organisations the caller can forward integration orders to.',
        description:
            'Every organisation the caller is a member of and holds ' +
            '`integrations.orders.write` in, ordered by name. Used by storefront ' +
            'connectors to choose the `X-Organisation-Slug` for POST ' +
            '/api/v1/integrations/orders. Takes no tenant header — the caller ' +
            'has not chosen an organisation yet. Empty array when there are none.',
    })
    @ApiAuthErrors()
    @ApiOkResponse({ type: [MemberOrganisationDto] })
    listMine(
        @Req() req: Request & { user: AuthedUser },
    ): Promise<MemberOrganisationDto[]> {
        return this.organisationsService.listForMember(
            req.user.id,
            ORDER_INGESTION_PERMISSION,
        );
    }
}
