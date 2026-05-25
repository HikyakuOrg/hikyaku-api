import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { IssuingService } from './issuing.service';
import { IssueCardDto } from './dto/issue-card.dto';
import { SetCardStatusDto } from './dto/set-card-status.dto';
import { CreateEphemeralKeyDto } from './dto/create-ephemeral-key.dto';

// Fuel cards are a fleet-admin function, so they reuse the vehicles.* permissions.
@ApiTags('issuing')
@Controller('api/v1/issuing')
@UseGuards(PermissionGuard)
export class IssuingController {
    constructor(private readonly issuing: IssuingService) {}

    @Post('cards')
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('vehicles.add')
    issueCard(
        @Body() dto: IssueCardDto,
        @Req() req: Request & { organisationId: string },
    ) {
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
    listCards(@Req() req: Request & { organisationId: string }) {
        return this.issuing.listCards(req.organisationId);
    }

    @Get('transactions')
    @RequirePermission('vehicles.view')
    listTransactions(
        @Req() req: Request & { organisationId: string },
        @Query('driverId') driverId?: string,
        @Query('vehicleId') vehicleId?: string,
    ) {
        return this.issuing.listTransactions(req.organisationId, {
            driverId,
            vehicleId,
        });
    }

    @Patch('cards/:id/status')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.update')
    setCardStatus(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: SetCardStatusDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.issuing.setCardStatus(req.organisationId, id, dto.status);
    }

    @Post('cards/:id/ephemeral-key')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('vehicles.view')
    createEphemeralKey(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: CreateEphemeralKeyDto,
        @Req() req: Request & { organisationId: string },
    ) {
        return this.issuing.createEphemeralKey(
            req.organisationId,
            id,
            dto.nonce,
            dto.apiVersion,
        );
    }
}
