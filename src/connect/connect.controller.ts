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
import { ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { SkipOrgContext } from 'src/auth/decorators/skip-org-context.decorator';
import { ConnectService } from './connect.service';
import { CreateAccountSessionDto } from './dto/create-account-session.dto';

// Connect/payments setup is an org-admin function; reuse the vehicles.* grants
// the fuel-card issuing already gates on (view = read state, add = mutate).
@ApiTags('connect')
@Controller('api/v1/connect')
@UseGuards(PermissionGuard)
export class ConnectController {
    constructor(private readonly connect: ConnectService) {}

    @Post('account-session')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    createAccountSession(
        @Body() dto: CreateAccountSessionDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.connect.createAccountSession(
            req.organisationId,
            dto.country,
        );
    }

    @Get('status')
    @RequirePermission('vehicles.view')
    getStatus(@Req() req: Request & { organisationId: string }) {
        return this.connect.getStatus(req.organisationId);
    }

    /**
     * Issuing-status flags for ALL orgs the caller belongs to.
     * Used by the org switcher — no active-org context needed, only a valid JWT.
     * Returns [{ slug, cardIssuingStatus, detailsSubmitted }].
     */
    @Get('issuing-statuses')
    @SkipOrgContext()
    getIssuingStatuses(@Req() req: Request & { user: { id: string } }) {
        return this.connect.getAllIssuingStatuses(req.user.id);
    }

    @Post('funding-instructions')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.add')
    getFundingInstructions(@Req() req: Request & { organisationId: string }) {
        return this.connect.getFundingInstructions(req.organisationId);
    }

    @Get('issuing-balance')
    @RequirePermission('vehicles.view')
    getIssuingBalance(@Req() req: Request & { organisationId: string }) {
        return this.connect.getIssuingBalance(req.organisationId);
    }
}
