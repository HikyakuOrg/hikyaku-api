import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import {
    ApiAuthErrors,
    ApiBadRequest,
    ApiGuardErrors,
} from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { SkipOrgContext } from 'src/auth/decorators/skip-org-context.decorator';
import { ConnectService } from './connect.service';
import { CreateAccountSessionDto } from './dto/create-account-session.dto';
import {
    AccountSessionDto,
    ConnectStatusDto,
    FundingInstructionsDto,
    IssuingBalanceDto,
    OrgIssuingStatusDto,
} from './dto/connect-results.dto';

/**
 * Connect/payments setup is an org-admin function; reuse the vehicles.* grants
 * the fuel-card issuing already gates on (view = read state, add = mutate).
 *
 * The tenant header is declared per route rather than on the controller:
 * `issuing-statuses` is @SkipOrgContext and deliberately takes none.
 */
@ApiTags('connect')
@ApiBearerAuth('bearer')
@Controller('api/v1/connect')
@UseGuards(PermissionGuard)
export class ConnectController {
    constructor(private readonly connect: ConnectService) {}

    @Post('account-session')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Start or resume embedded Stripe onboarding.',
        description:
            'Creates the organisation’s connected account on first call, then ' +
            'returns an Account Session for the embedded onboarding component. ' +
            '`country` is only read when the account is created — it is immutable ' +
            'afterwards and ignored on later calls.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: AccountSessionDto })
    createAccountSession(
        @Body() dto: CreateAccountSessionDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<AccountSessionDto> {
        return this.connect.createAccountSession(
            req.organisationId,
            dto.country,
        );
    }

    @Get('status')
    @RequirePermission('vehicles.view')
    @ApiOperation({
        summary: 'Onboarding and capability state for the active organisation.',
        description:
            'Read live from Stripe. An organisation with no connected account ' +
            'gets a fully null/false body rather than an error.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: ConnectStatusDto })
    getStatus(@Req() req: Request & { organisationId: string }): Promise<ConnectStatusDto> {
        return this.connect.getStatus(req.organisationId);
    }

    /**
     * Issuing-status flags for ALL orgs the caller belongs to.
     * Used by the org switcher — no active-org context needed, only a valid JWT.
     * Returns [{ slug, cardIssuingStatus, detailsSubmitted }].
     */
    @Get('issuing-statuses')
    @SkipOrgContext()
    @ApiOperation({
        summary: 'Issuing state for every organisation the caller belongs to.',
        description:
            'Deliberately takes no tenant header — it runs before an organisation ' +
            'has been chosen, and is what the org switcher reads. Requires only a ' +
            'valid bearer token.',
    })
    @ApiAuthErrors()
    @ApiOkResponse({ type: [OrgIssuingStatusDto] })
    getIssuingStatuses(
        @Req() req: Request & { user: { id: string } },
    ): Promise<OrgIssuingStatusDto[]> {
        return this.connect.getAllIssuingStatuses(req.user.id);
    }

    @Post('funding-instructions')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Bank coordinates for topping up the Issuing balance.',
        description:
            'The organisation self-funds its own card spend, so this returns where ' +
            'to wire money to. A POST because Stripe’s own endpoint is one — ' +
            'calling it can provision the coordinates on first use. The response ' +
            'is forwarded from Stripe verbatim.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: FundingInstructionsDto })
    @ApiBadRequest(
        'The organisation has no Stripe account yet, or its currency has no ' +
            'supported bank-transfer rail.',
    )
    getFundingInstructions(
        @Req() req: Request & { organisationId: string },
    ): Promise<unknown> {
        return this.connect.getFundingInstructions(req.organisationId);
    }

    @Get('issuing-balance')
    @RequirePermission('vehicles.view')
    @ApiOperation({
        summary: 'Spendable Issuing balance, per currency.',
        description:
            'Empty array when the account holds no Issuing funds. Separate from ' +
            'the account’s payments balance.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: [IssuingBalanceDto] })
    @ApiBadRequest('The organisation has no Stripe account yet.')
    getIssuingBalance(
        @Req() req: Request & { organisationId: string },
    ): Promise<IssuingBalanceDto[]> {
        return this.connect.getIssuingBalance(req.organisationId);
    }
}
