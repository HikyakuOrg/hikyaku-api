import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiBody,
    ApiHeader,
    ApiOperation,
    ApiQuery,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from 'src/common/swagger/api-error.dto';
import { ApiGuardErrors } from 'src/common/swagger/api-errors.decorator';
import { ApiOrganisationSlugHeader } from 'src/common/swagger/tenant-header.decorator';
import { PermissionGuard } from 'src/auth/guards/permission.guard';
import { RequirePermission } from 'src/auth/decorators/required-permission.decorator';
import { OrderEventDto } from './dto/order-event.dto';
import {
    ORDER_EVENT_STATUSES,
    OrderEventRecordDto,
    OrderEventRecordListDto,
    RecordedOrderEventDto,
    type OrderEventStatus,
} from './dto/recorded-order-event.dto';
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
 * Generic ecommerce connector ingestion. One route, never named
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
            'Validates and durably stores the event, keyed by (organisation, ' +
            'platform, Idempotency-Key), and returns without waiting for ' +
            'anything else. An `order.paid` event that needs delivery is then ' +
            'turned into a customer and a package, and assigned, in the ' +
            'background; follow it with GET /api/v1/integrations/orders. A ' +
            'replay creates nothing new.',
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

    @Get('orders')
    @RequirePermission('packages.view')
    @ApiOperation({
        summary: 'List recorded order events and what they produced.',
        description:
            'Newest first. Filter by `status=needs_attention` for the orders ' +
            'that could not become a package without a human (an address ' +
            'that cannot be placed on the map, no warehouse, a storefront ' +
            'location not mapped to a warehouse), each with the reason in ' +
            '`error`.',
    })
    @ApiQuery({ name: 'status', required: false, enum: ORDER_EVENT_STATUSES })
    @ApiQuery({
        name: 'limit',
        required: false,
        type: Number,
        description: 'Maximum rows, 1 to 200. Defaults to 50.',
    })
    @ApiResponse({ status: 200, type: OrderEventRecordListDto })
    async listOrders(
        @Req() req: Request & { organisationId: string },
        @Query('status') status?: string,
        @Query('limit') limit?: string,
    ): Promise<OrderEventRecordListDto> {
        if (
            status !== undefined &&
            !(ORDER_EVENT_STATUSES as readonly string[]).includes(status)
        ) {
            throw new BadRequestException(
                `status must be one of: ${ORDER_EVENT_STATUSES.join(', ')}`,
            );
        }
        const parsedLimit = limit === undefined ? 50 : Number(limit);
        if (
            !Number.isInteger(parsedLimit) ||
            parsedLimit < 1 ||
            parsedLimit > 200
        ) {
            throw new BadRequestException(
                'limit must be an integer from 1 to 200',
            );
        }

        const data = await this.integrations.listOrderEvents(
            req.organisationId,
            status as OrderEventStatus | undefined,
            parsedLimit,
        );
        return { data };
    }

    @Post('orders/:id/retry')
    @HttpCode(HttpStatus.OK)
    @RequirePermission('packages.add')
    @ApiOperation({
        summary: 'Retry an order event that needs attention or has failed.',
        description:
            'Queues the event for processing again with a fresh attempt ' +
            'budget, once the cause in `error` has been fixed. Packages it ' +
            'already produced are kept, and fulfillment groups that already ' +
            'have a package are not made again.',
    })
    @ApiResponse({
        status: 200,
        description: 'Queued. `status` is now `pending`.',
        type: OrderEventRecordDto,
    })
    @ApiResponse({
        status: 404,
        description: 'No such order event in this organisation.',
        type: ApiErrorDto,
    })
    @ApiResponse({
        status: 409,
        description:
            'The event is not in `needs_attention` or `failed`, so there is ' +
            'nothing to retry.',
        type: ApiErrorDto,
    })
    retryOrder(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<OrderEventRecordDto> {
        return this.integrations.retryOrderEvent(req.organisationId, id);
    }
}
