import { ApiProperty } from '@nestjs/swagger';

/**
 * 200/201 body of `POST /api/v1/integrations/orders`. Recording is all the
 * request does; the customer and package are made afterwards by the order
 * event worker, so the ledger row's id is the only thing known yet. Follow it
 * with `GET /api/v1/integrations/orders`.
 */
export class RecordedOrderEventDto {
    @ApiProperty({
        format: 'uuid',
        description: 'The integration_order_event row id.',
    })
    id: string;
}

export const ORDER_EVENT_STATUSES = [
    'pending',
    'processing',
    'processed',
    'skipped',
    'needs_attention',
    'failed',
] as const;

export type OrderEventStatus = (typeof ORDER_EVENT_STATUSES)[number];

/** One recorded order event and what processing it produced. */
export class OrderEventRecordDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'shopify' })
    platform: string;

    @ApiProperty({ example: 'order.paid' })
    eventType: string;

    @ApiProperty({
        description: "The order's id in the storefront's system.",
    })
    externalOrderId: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Human-facing order number, e.g. "#1001".',
    })
    orderName: string | null;

    @ApiProperty({
        enum: ORDER_EVENT_STATUSES,
        description:
            '`pending`/`processing`: not done yet. `processed`: ' +
            '`packageIds` and `customerId` say what it produced. `skipped`: ' +
            'nothing to deliver. `needs_attention`: a human has to fix ' +
            'something (see `error`), then retry; for an order split by ' +
            'fulfillment group, the groups that could be processed already ' +
            'have their packages in `packageIds`. `failed`: transient ' +
            'failures exhausted the retry budget; retry once the cause is ' +
            'fixed.',
    })
    status: OrderEventStatus;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'Why the event was skipped, needs attention, failed, or is ' +
            'waiting to be retried.',
    })
    error: string | null;

    @ApiProperty({ description: 'Processing attempts so far.' })
    attempts: number;

    @ApiProperty({ type: String, format: 'uuid', nullable: true })
    customerId: string | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'The first of `packageIds`. Kept for clients written before an ' +
            'order could produce more than one package.',
    })
    packageId: string | null;

    @ApiProperty({
        type: [String],
        format: 'uuid',
        description:
            'Every package this event produced or was matched to: one for a ' +
            'whole order, one per delivered fulfillment group for an order ' +
            'that ships from several locations. Empty when it produced none.',
    })
    packageIds: string[];

    @ApiProperty({ format: 'date-time' })
    createdAt: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    processedAt: string | null;
}

export class OrderEventRecordListDto {
    @ApiProperty({ type: [OrderEventRecordDto] })
    data: OrderEventRecordDto[];
}
