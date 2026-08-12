import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { IssuingService } from './issuing.service';
import { IssueCardDto } from './dto/issue-card.dto';
import { SetCardStatusDto } from './dto/set-card-status.dto';
import { CreateEphemeralKeyDto } from './dto/create-ephemeral-key.dto';
import {
    EphemeralKeyDto,
    IssuingCardDto,
    IssuingTransactionDto,
} from './dto/issuing-results.dto';

// Fuel cards are a fleet-admin function, so they reuse the vehicles.* permissions.
@ApiTags('issuing')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/issuing')
@UseGuards(PermissionGuard)
export class IssuingController {
    constructor(private readonly issuing: IssuingService) {}

    @Post('cards')
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('vehicles.add')
    @ApiOperation({
        summary: 'Issue a virtual fuel card to a driver.',
        description:
            'Restricted by Stripe to fuel merchant categories, so anything else ' +
            'is auto-declined. A Stripe cardholder is created for the driver on ' +
            'first issue, using their assigned warehouse as the billing address. ' +
            'Requires the organisation to have completed onboarding with the ' +
            'card_issuing capability active.',
    })
    @ApiCreatedResponse({ type: IssuingCardDto })
    issueCard(
        @Body() dto: IssueCardDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<IssuingCardDto> {
        return this.issuing.issueCard(req.organisationId, {
            driverId: dto.driverId,
            vehicleId: dto.vehicleId ?? null,
            spendingLimitMajor: dto.spendingLimitMajor ?? null,
            interval: dto.interval,
            currency: dto.currency,
        });
    }

    @Get('cards')
    @RequirePermission('vehicles.view')
    @ApiOperation({
        summary: 'List the organisation’s fuel cards.',
        description:
            'Read live from Stripe, capped at 100 and not paginated. Returns an ' +
            'empty array — not an error — when the organisation has no connected ' +
            'account or issuing is not active yet.',
    })
    @ApiOkResponse({ type: [IssuingCardDto] })
    listCards(@Req() req: Request & { organisationId: string }): Promise<IssuingCardDto[]> {
        return this.issuing.listCards(req.organisationId);
    }

    @Get('transactions')
    @RequirePermission('vehicles.view')
    @ApiOperation({
        summary: 'List fuel-card transactions.',
        description:
            'The 100 most recent transactions from Stripe, not paginated. Filters ' +
            'are applied in memory to that window, so a narrow filter can return ' +
            'nothing even when older matching transactions exist. Empty array when ' +
            'issuing is not active.',
    })
    @ApiQuery({
        name: 'driverId',
        required: false,
        type: String,
        format: 'uuid',
        description: 'Keep only transactions on cards held by this driver.',
    })
    @ApiQuery({
        name: 'vehicleId',
        required: false,
        type: String,
        format: 'uuid',
        description: 'Keep only transactions on cards linked to this vehicle.',
    })
    @ApiOkResponse({ type: [IssuingTransactionDto] })
    listTransactions(
        @Req() req: Request & { organisationId: string },
        @Query('driverId') driverId?: string,
        @Query('vehicleId') vehicleId?: string,
    ): Promise<IssuingTransactionDto[]> {
        return this.issuing.listTransactions(req.organisationId, {
            driverId,
            vehicleId,
        });
    }

    // `:id` here is a Stripe card id (`ic_…`), not a local UUID — no ParseUUIDPipe.
    @Patch('cards/:id/status')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.update')
    @ApiOperation({
        summary: 'Freeze, unfreeze or cancel a card.',
        description:
            '`inactive` freezes the card and is reversible; `canceled` is ' +
            'permanent and cannot be undone.',
    })
    @ApiParam({
        name: 'id',
        description: 'Stripe card id (`ic_…`), not a local UUID.',
        example: 'ic_1QhX1a2B3c4D5e6',
    })
    @ApiOkResponse({ type: IssuingCardDto })
    setCardStatus(
        @Param('id') id: string,
        @Body() dto: SetCardStatusDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<IssuingCardDto> {
        return this.issuing.setCardStatus(req.organisationId, id, dto.status);
    }

    @Post('cards/:id/ephemeral-key')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.view')
    @ApiOperation({
        summary: 'Mint an ephemeral key for revealing card details.',
        description:
            'Returns a short-lived secret for Stripe Issuing Elements so the ' +
            'client can display the full card number. The PAN never passes ' +
            'through this server. The nonce is single-use — request a fresh key ' +
            'per reveal.',
    })
    @ApiParam({
        name: 'id',
        description: 'Stripe card id (`ic_…`), not a local UUID.',
        example: 'ic_1QhX1a2B3c4D5e6',
    })
    @ApiOkResponse({ type: EphemeralKeyDto })
    createEphemeralKey(
        @Param('id') id: string,
        @Body() dto: CreateEphemeralKeyDto,
        @Req() req: Request & { organisationId: string },
    ): Promise<EphemeralKeyDto> {
        return this.issuing.createEphemeralKey(
            req.organisationId,
            id,
            dto.nonce,
            dto.apiVersion,
        );
    }
}
