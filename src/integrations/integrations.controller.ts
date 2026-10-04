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

/** The most order ids one GET /orders can filter by. */
const MAX_EXTERNAL_ORDER_IDS = 100;

/**
 * The slice of the Fastify reply this controller needs — see
 * PackagesController for why this is declared locally rather than imported
 * from `fastify`.
 */
interface StatusReply {
    status(code: number): { send(body: unknown): unknown };
}

/**
 * Generic ecommerce connector ingestion. No route is named after a platform:
 * `platform` comes from `source.platform` in the body. Every storefront
 * connector POSTs its translated event here.
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
            'Stores the event, keyed by (organisation, platform, ' +
            'Idempotency-Key), and returns at once. Processing runs in the ' +
            'background; track it with GET /api/v1/integrations/orders. ' +
            '`order.paid` creates the customer and packages and assigns ' +
            'them. `order.fulfillment_updated` deletes packages that no ' +
            'longer match their group and creates packages for new groups; ' +
            'if a changed package is already loaded, nothing changes and the ' +
            'event needs attention. A replay creates nothing.',
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
            'Newest first. `status=needs_attention` lists the orders that ' +
            'need a fix (bad address, no warehouse, unmapped location); ' +
            '`error` gives the reason. `external_order_ids` lists the events ' +
            'of those orders, so a connector can tell which of its orders ' +
            'Hikyaku already has.',
    })
    @ApiQuery({ name: 'status', required: false, enum: ORDER_EVENT_STATUSES })
    @ApiQuery({
        name: 'platform',
        required: false,
        type: String,
        description: 'Only events from this platform, e.g. `shopify`.',
    })
    @ApiQuery({
        name: 'external_order_ids',
        required: false,
        type: String,
        description: `Comma-separated order ids (\`order.id\` of the events), at most ${MAX_EXTERNAL_ORDER_IDS}.`,
    })
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
        @Query('platform') platform?: string,
        @Query('external_order_ids') externalOrderIdsParam?: string,
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

        let externalOrderIds: string[] | undefined;
        if (externalOrderIdsParam !== undefined) {
            externalOrderIds = externalOrderIdsParam
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean);
            if (
                externalOrderIds.length === 0 ||
                externalOrderIds.length > MAX_EXTERNAL_ORDER_IDS
            ) {
                throw new BadRequestException(
                    `external_order_ids must list 1 to ${MAX_EXTERNAL_ORDER_IDS} order ids`,
                );
            }
        }

        const data = await this.integrations.listOrderEvents(
            req.organisationId,
            {
                status: status as OrderEventStatus | undefined,
                platform: platform || undefined,
                externalOrderIds,
            },
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
            'Re-queues the event with a fresh attempt budget. Fix the cause ' +
            'in `error` first. Existing packages are kept; only groups ' +
            'without a package get one.',
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
        description: 'The event is not `needs_attention` or `failed`.',
        type: ApiErrorDto,
    })
    retryOrder(
        @Param('id', ParseUUIDPipe) id: string,
        @Req() req: Request & { organisationId: string },
    ): Promise<OrderEventRecordDto> {
        return this.integrations.retryOrderEvent(req.organisationId, id);
    }
}
