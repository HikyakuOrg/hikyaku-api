import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { AllowExpiredTrial } from 'src/auth/decorators/allow-expired-trial.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { BillingService } from './billing.service';
import { TrialStatusDto } from './dto/trial-status.dto';
import { ShiftUsageStatusDto } from './dto/shift-usage.dto';
import { VanityUrlStatusDto } from './dto/vanity-url-status.dto';
import {
    BillingPortalSessionDto,
    CreateBillingPortalSessionDto,
} from './dto/create-billing-portal-session.dto';

/**
 * Billing state for the active organisation.
 *
 * No @RequirePermission: the trial deadline is org-wide and every member sees the
 * same countdown and the same lockout, so gating it on an admin grant would leave
 * ordinary members staring at a blocked dashboard with no explanation. Membership
 * — which PermissionGuard still enforces — is the right bar here.
 */
@ApiTags('billing')
@ApiBearerAuth('bearer')
@Controller('api/v1/billing')
@UseGuards(PermissionGuard)
export class BillingController {
    constructor(private readonly billing: BillingService) {}

    @Get('trial')
    @AllowExpiredTrial()
    @ApiOperation({
        summary: 'Trial state for the active organisation.',
        description:
            'Deliberately exempt from the expired-trial block it reports on — an ' +
            'org whose trial has ended must still be able to read why it is locked ' +
            'out, otherwise the dashboard could only show a bare error.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: TrialStatusDto })
    getTrial(
        @Req() req: Request & { organisationId: string },
    ): Promise<TrialStatusDto> {
        return this.billing.getTrialStatus(req.organisationId);
    }

    @Get('usage')
    @AllowExpiredTrial()
    @ApiOperation({
        summary: 'Shift usage for the active organisation this billing period.',
        description:
            'Read-only mirror of what the enforce_shift_allowance() DB trigger is ' +
            'deciding on. Exempt from the expired-trial block for the same reason ' +
            'as GET /billing/trial — an org that is blocked must still be able to ' +
            'read why.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: ShiftUsageStatusDto })
    getShiftUsage(
        @Req() req: Request & { organisationId: string },
    ): Promise<ShiftUsageStatusDto> {
        return this.billing.getShiftUsageStatus(req.organisationId);
    }

    @Get('vanity-url')
    @AllowExpiredTrial()
    @ApiOperation({
        summary: 'Vanity URL entitlement state for the active organisation.',
        description:
            'Whether the organisation is currently entitled to a vanity ' +
            'booking subdomain. Exempt from the expired-trial block for the ' +
            'same reason as the other endpoints on this controller — an org ' +
            'whose vanity host has stopped resolving because its trial ended ' +
            'must still be able to read why.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: VanityUrlStatusDto })
    getVanityUrlStatus(
        @Req() req: Request & { organisationId: string },
    ): Promise<VanityUrlStatusDto> {
        return this.billing.getVanityUrlStatus(req.organisationId);
    }

    @Post('portal')
    @AllowExpiredTrial()
    @ApiOperation({
        summary:
            'Create a Stripe Billing Portal session for the active organisation.',
        description:
            'Used by the "Add payment method" action once an org has exhausted its ' +
            'free shift allowance. Exempt from the expired-trial block: adding a ' +
            'payment method is exactly what an org needs to be able to do once ' +
            'blocked.',
    })
    @ApiOrganisationSlugHeader()
    @ApiGuardErrors()
    @ApiOkResponse({ type: BillingPortalSessionDto })
    createPortalSession(
        @Req() req: Request & { organisationId: string },
        @Body() body: CreateBillingPortalSessionDto,
    ): Promise<BillingPortalSessionDto> {
        return this.billing.createBillingPortalSession(
            req.organisationId,
            body.returnUrl,
        );
    }
}
