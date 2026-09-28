import { ApiProperty } from '@nestjs/swagger';

/**
 * 200/201 body of `POST /api/v1/integrations/orders`. Processing happens
 * later, so only the ledger row id is known. Track it with
 * `GET /api/v1/integrations/orders`.
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
        description: "The order's storefront id.",
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
            '`pending`, `processing`: in progress. `processed`: see ' +
            '`packageIds` and `customerId`. `skipped`: nothing to deliver. ' +
            '`needs_attention`: fix the cause in `error`, then retry; groups ' +
            'that succeeded are already in `packageIds`. `failed`: retries ' +
            'exhausted; fix the cause, then retry.',
    })
    status: OrderEventStatus;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'Reason for `skipped`, `needs_attention` or `failed`, or for a ' +
            'pending retry.',
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
        description: 'The first of `packageIds`, for older clients.',
    })
    packageId: string | null;

    @ApiProperty({
        type: [String],
        format: 'uuid',
        description:
            'Packages linked to this event: one for a whole order, or one per ' +
            'delivered fulfillment group. Empty if none.',
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
