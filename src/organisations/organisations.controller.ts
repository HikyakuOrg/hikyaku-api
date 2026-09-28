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
 * GET /organisations/me lists only organisations where the caller has this
 * permission. POST /integrations/orders requires it, so any other
 * organisation would reject every order with 403.
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
            'Organisations where the caller has ' +
            '`integrations.orders.write`, ordered by name. Connectors send ' +
            'the `slug` as `X-Organisation-Slug` on POST ' +
            '/api/v1/integrations/orders. Takes no tenant header.',
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
