import {
    BadRequestException,
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiHeader,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { OrderEventDto } from './dto/order-event.dto';
import { RecordedOrderEventDto } from './dto/recorded-order-event.dto';
import { IntegrationsService } from './integrations.service';

/**
 * The slice of the Fastify reply this controller needs — see
 * PackagesController for why this is declared locally rather than imported
 * from `fastify`.
 */
interface StatusReply {
    status(code: number): { send(body: unknown): unknown };
}

/**
 * Generic ecommerce connector ingestion (HIK-99). One route, never named
 * after a platform: `platform` is a data value on the body, read from
 * `source.platform`, not a path segment. Every storefront connector (Shopify
 * today; WooCommerce/Magento/MedusaJS later) POSTs its translated event here.
 */
@ApiTags('integrations')
@ApiBearerAuth('bearer')
@ApiOrganisationSlugHeader()
@ApiGuardErrors()
@Controller('api/v1/integrations')
@UseGuards(PermissionGuard)
export class IntegrationsController {
    constructor(private readonly integrations: IntegrationsService) {}

    @Post('orders')
    @HttpCode(HttpStatus.CREATED)
    @RequirePermission('integrations.orders.write')
    @ApiOperation({
        summary: 'Record an external order event.',
        description:
            'Record-only for now: validates and durably stores the event, ' +
            'keyed by (organisation, platform, Idempotency-Key). It does not ' +
            'create a customer or package — see HIK-99.',
    })
    @ApiHeader({
        name: 'Idempotency-Key',
        required: true,
        description:
            'Caller-chosen key, unique per organisation and platform. A retry ' +
            'with the same key and the same order replays the original result; ' +
            'the same key with a different order is rejected as a conflict.',
    })
    @ApiBody({ type: OrderEventDto })
    @ApiResponse({
        status: 201,
        description: 'Recorded.',
        type: RecordedOrderEventDto,
    })
    @ApiResponse({
        status: 200,
        description:
            'Idempotent replay: this Idempotency-Key already recorded this ' +
            'order, and the original row is returned unchanged.',
        type: RecordedOrderEventDto,
    })
    @ApiResponse({
        status: 409,
        description:
            'This Idempotency-Key was already used for a different order.',
        type: ApiErrorDto,
    })
    async recordOrder(
        @Body() dto: OrderEventDto,
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Req() req: Request & { organisationId: string },
        // Written to directly rather than through @HttpCode, because the
        // status depends on the outcome — see PackagesController.create.
        @Res() reply: StatusReply,
    ): Promise<void> {
        if (!idempotencyKey) {
            throw new BadRequestException('Missing Idempotency-Key header');
        }

        const { result, replayed } = await this.integrations.recordOrderEvent(
            req.organisationId,
            idempotencyKey,
            dto,
        );
        reply
            .status(replayed ? HttpStatus.OK : HttpStatus.CREATED)
            .send(result);
    }
}
