import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { AllowExpiredTrial } from 'src/auth/decorators/allow-expired-trial.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { BillingService } from './billing.service';
import { TrialStatusDto } from './dto/trial-status.dto';

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
}
