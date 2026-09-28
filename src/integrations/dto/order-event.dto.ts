import {
    ApiExtraModels,
    ApiProperty,
    ApiPropertyOptional,
    getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsDefined,
    IsIn,
    IsInt,
    IsISO8601,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Min,
    Validate,
    ValidateIf,
    ValidateNested,
    ValidatorConstraint,
    ValidatorConstraintInterface,
    ValidationArguments,
} from 'class-validator';

/** A paid order: the event that produces packages. */
export const ORDER_PAID = 'order.paid';

/**
 * The storefront re-routed an order's items after payment (moved them to
 * another location, split or merged its groups, cancelled one). Carries the
 * order's current fulfillment groups in full, not the change, and refers to
 * the order by id only: its recipient and line items come from the order.paid
 * event already recorded for it.
 */
export const ORDER_FULFILLMENT_UPDATED = 'order.fulfillment_updated';

/** Whether a raw event body is an order.fulfillment_updated event. */
function isFulfillmentUpdate(body: unknown): boolean {
    return (
        (body as { event?: { type?: unknown } } | null)?.event?.type ===
        ORDER_FULFILLMENT_UPDATED
    );
}

/**
 * The generic order-event contract every storefront connector translates its
 * native webhook into before POSTing to `/api/v1/integrations/orders` (see
 * HIK-99). Mirrors `OrderPaidEvent` in hikyaku-shopify's
 * `app/lib/order-event.server.ts` field-for-field — that shape is the one
 * already implemented and shipping in the Shopify connector, and every future
 * connector (WooCommerce, Magento, MedusaJS) targets this same contract.
 *
 * hikyaku-api's global ValidationPipe runs with `whitelist: true,
 * forbidNonWhitelisted: true`. Every nested object below therefore carries
 * both `@ValidateNested()` and `@Type(() => X)` — without both, class-
 * transformer never builds the nested instance class-validator needs, and
 * the field silently strips down to `{}`.
 */
export class OrderEventInfoDto {
    @ApiProperty({
        description:
            'The connector-assigned id for this event. Shopify uses its ' +
            'webhook delivery id, which also doubles as the Idempotency-Key ' +
            'header value.',
    })
    @IsString()
    @IsNotEmpty()
    id: string;

    @ApiProperty({
        description:
            'Event type. "order.paid" creates the packages; ' +
            '"order.fulfillment_updated" re-routes them after the storefront ' +
            'moved, split, merged or cancelled fulfillment groups. An open ' +
            'string, not a closed enum, so a connector can introduce a new ' +
            'event type without a hikyaku-api change; other types are ' +
            'recorded and skipped.',
        example: 'order.paid',
    })
    @IsString()
    @IsNotEmpty()
    type: string;

    @ApiProperty({ format: 'date-time' })
    @IsISO8601()
    occurred_at: string;

    @ApiProperty({ description: "The source platform's API version string." })
    @IsString()
    @IsNotEmpty()
    api_version: string;
}

export class OrderEventSourceDto {
    @ApiProperty({
        description:
            'Lowercase connector slug (e.g. "shopify"). An open, validated ' +
            'string — never a closed enum. hikyaku-api never learns a ' +
            'platform name as code; every future connector needs zero ' +
            'hikyaku-api changes to add one.',
        example: 'shopify',
    })
    @IsString()
    @Matches(/^[a-z0-9-]+$/, {
        message: 'platform must be a lowercase slug (a-z, 0-9, -)',
    })
    platform: string;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description: "The storefront's own domain, when the platform has one.",
    })
    @IsOptional()
    @IsString()
    shop_domain?: string | null;

    @ApiProperty({ description: "The connector app's own version string." })
    @IsString()
    @IsNotEmpty()
    app_version: string;
}

export class OrderLineItemDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    id: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    title: string;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    variant_title: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    sku: string | null;

    @ApiProperty()
    @IsNumber()
    quantity: number;

    @ApiProperty({
        description: 'Decimal string, matching the source currency.',
    })
    @IsString()
    @IsNotEmpty()
    price: string;

    @ApiProperty()
    @IsNumber()
    grams: number;

    @ApiProperty()
    @IsBoolean()
    requires_shipping: boolean;
}

export class OrderInfoDto {
    @ApiProperty({
        description:
            "The order's id in the source platform's system. Shopify sends " +
            'its GraphQL global id here.',
    })
    @IsString()
    @IsNotEmpty()
    id: string;

    @ApiProperty({
        description:
            "The order's numeric/legacy id in the source platform, where one " +
            'exists.',
    })
    @IsNumber()
    legacy_id: number;

    @ApiProperty({
        description: 'Human-facing order name/number, e.g. "#1001".',
    })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ format: 'date-time' })
    @IsISO8601()
    created_at: string;

    @ApiProperty({ type: String, format: 'date-time', nullable: true })
    @IsOptional()
    @IsISO8601()
    processed_at: string | null;

    @ApiProperty({ description: 'ISO 4217 currency code.' })
    @IsString()
    @IsNotEmpty()
    currency: string;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    financial_status: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    fulfillment_status: string | null;

    @ApiProperty({ description: 'Decimal string, matching `currency`.' })
    @IsString()
    @IsNotEmpty()
    total_price: string;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    subtotal_price: string | null;

    @ApiProperty({ description: 'Decimal string, matching `currency`.' })
    @IsString()
    @IsNotEmpty()
    total_shipping: string;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    total_tax: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    note: string | null;

    @ApiProperty({ type: [String] })
    @IsArray()
    @IsString({ each: true })
    tags: string[];

    @ApiProperty({ type: Number, nullable: true })
    @IsOptional()
    @IsNumber()
    total_weight_grams: number | null;

    @ApiProperty({ type: () => [OrderLineItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OrderLineItemDto)
    line_items: OrderLineItemDto[];
}

/**
 * The order an `order.fulfillment_updated` event is about. Only the id is
 * needed: everything else was recorded with the order's `order.paid` event.
 */
export class OrderReferenceDto {
    @ApiProperty({
        description:
            'The same `order.id` the order.paid event for this order carried.',
    })
    @IsString()
    @IsNotEmpty()
    id: string;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description: 'Human-facing order name/number, e.g. "#1001".',
    })
    @IsOptional()
    @IsString()
    name?: string | null;
}

export class OrderEventCustomerDto {
    @ApiProperty({
        type: String,
        nullable: true,
        description: "The customer's id in the source platform's system.",
    })
    @IsOptional()
    @IsString()
    id: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    first_name: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    last_name: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    email: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    phone: string | null;
}

export class OrderDeliveryAddressDto {
    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    line1: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    line2: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    city: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    province: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    province_code: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    postcode: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    country: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    country_code: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    company: string | null;
}

export class OrderDeliveryDto {
    @ApiProperty({
        description:
            'Whether this order needs physical delivery at all — false for a ' +
            'fully digital/no-shipping order.',
    })
    @IsBoolean()
    required: boolean;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    recipient_name: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    phone: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    email: string | null;

    @ApiProperty({ type: () => OrderDeliveryAddressDto, nullable: true })
    @IsOptional()
    @ValidateNested()
    @Type(() => OrderDeliveryAddressDto)
    address: OrderDeliveryAddressDto | null;

    @ApiProperty({
        type: Number,
        nullable: true,
        minimum: -90,
        maximum: 90,
    })
    @IsOptional()
    @IsNumber()
    latitude: number | null;

    @ApiProperty({
        type: Number,
        nullable: true,
        minimum: -180,
        maximum: 180,
    })
    @IsOptional()
    @IsNumber()
    longitude: number | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    shipping_method: string | null;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    instructions: string | null;
}

/**
 * How the storefront hands over the items in one fulfillment group. Only
 * `shipping` and `local` leave Hikyaku anything to deliver; a `pickup` or
 * `none` group has nothing to dispatch.
 */
export const FULFILLMENT_DELIVERY_METHODS = [
    'shipping',
    'local',
    'pickup',
    'none',
] as const;

export type FulfillmentDeliveryMethod =
    (typeof FULFILLMENT_DELIVERY_METHODS)[number];

export class OrderFulfillmentGroupLineItemDto {
    @ApiProperty({
        description: 'The `id` of an entry in `order.line_items`.',
    })
    @IsString()
    @IsNotEmpty()
    line_item_id: string;

    @ApiProperty({
        type: 'integer',
        minimum: 1,
        description:
            'How many units of that line item this group fulfils. May be ' +
            "less than the line item's own quantity when a line is split " +
            'across locations.',
    })
    @IsInt()
    @Min(1)
    quantity: number;
}

/**
 * The items one storefront location fulfils for this order. The location is
 * resolved to a Hikyaku warehouse through PUT /api/v1/integrations/locations.
 */
export class OrderFulfillmentGroupDto {
    @ApiProperty({
        description:
            "The storefront's own id for this group (its fulfillment order, " +
            'shipment or equivalent).',
        example: 'gid://shopify/FulfillmentOrder/1',
    })
    @IsString()
    @IsNotEmpty()
    id: string;

    @ApiProperty({
        description:
            "The fulfilling location's id in the storefront's own system, as " +
            'sent to PUT /api/v1/integrations/locations.',
        example: 'gid://shopify/Location/123',
    })
    @IsString()
    @IsNotEmpty()
    external_location_id: string;

    @ApiProperty({ type: String, nullable: true })
    @IsOptional()
    @IsString()
    external_location_name: string | null;

    @ApiProperty({ enum: FULFILLMENT_DELIVERY_METHODS })
    @IsIn(FULFILLMENT_DELIVERY_METHODS)
    delivery_method: FulfillmentDeliveryMethod;

    @ApiProperty({ type: () => [OrderFulfillmentGroupLineItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OrderFulfillmentGroupLineItemDto)
    line_items: OrderFulfillmentGroupLineItemDto[];

    @ApiProperty({ type: Number, nullable: true })
    @IsOptional()
    @IsNumber()
    total_weight_grams: number | null;
}

/**
 * Every `fulfillment_groups[].line_items[].line_item_id` must name an
 * `order.line_items[].id`. Shape errors (a missing array, a non-string id)
 * are left to the property validators, so this only reports dangling ids.
 */
@ValidatorConstraint({ name: 'FulfillmentLineItemsInOrder', async: false })
export class FulfillmentLineItemsInOrderConstraint implements ValidatorConstraintInterface {
    validate(value: unknown, args: ValidationArguments): boolean {
        return unknownLineItemIds(value, args.object).length === 0;
    }

    defaultMessage(args: ValidationArguments): string {
        const unknown = unknownLineItemIds(args.value, args.object);
        return (
            'fulfillment_groups line_item_id must reference an ' +
            `order.line_items id; unknown: ${unknown.join(', ')}`
        );
    }
}

function unknownLineItemIds(groups: unknown, dto: object): string[] {
    const orderLineItems = (dto as { order?: { line_items?: unknown } }).order
        ?.line_items;
    if (!Array.isArray(groups) || !Array.isArray(orderLineItems)) return [];

    const known = new Set(
        orderLineItems.map((item) => (item as { id?: unknown } | null)?.id),
    );
    const unknown = new Set<string>();
    for (const group of groups) {
        const items = (group as { line_items?: unknown } | null)?.line_items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            const id = (item as { line_item_id?: unknown } | null)
                ?.line_item_id;
            if (typeof id === 'string' && !known.has(id)) unknown.add(id);
        }
    }
    return [...unknown];
}

/**
 * One body for every event type. `order.paid` carries the whole order;
 * `order.fulfillment_updated` carries only `order.id`, the order's current
 * `fulfillment_groups` and `released_group_ids`, and leaves out `customer` and
 * `delivery`. The shape of `order` is picked from `event.type` before
 * validation, so each type is held to its own required fields.
 */
@ApiExtraModels(OrderInfoDto, OrderReferenceDto)
export class OrderEventDto {
    @ApiProperty({ type: () => OrderEventInfoDto })
    @ValidateNested()
    @Type(() => OrderEventInfoDto)
    event: OrderEventInfoDto;

    @ApiProperty({ type: () => OrderEventSourceDto })
    @ValidateNested()
    @Type(() => OrderEventSourceDto)
    source: OrderEventSourceDto;

    @ApiProperty({
        oneOf: [
            { $ref: getSchemaPath(OrderInfoDto) },
            { $ref: getSchemaPath(OrderReferenceDto) },
        ],
        description:
            'The whole order for `order.paid`; just its id (and optionally ' +
            'its name) for `order.fulfillment_updated`.',
    })
    @ValidateNested()
    @Type((options) =>
        isFulfillmentUpdate(options?.object) ? OrderReferenceDto : OrderInfoDto,
    )
    order: OrderInfoDto | OrderReferenceDto;

    @ApiPropertyOptional({
        type: () => OrderEventCustomerDto,
        description: 'Required, except on `order.fulfillment_updated`.',
    })
    @ValidateIf((body) => !isFulfillmentUpdate(body))
    @IsDefined()
    @ValidateNested()
    @Type(() => OrderEventCustomerDto)
    customer?: OrderEventCustomerDto;

    @ApiPropertyOptional({
        type: () => OrderDeliveryDto,
        description: 'Required, except on `order.fulfillment_updated`.',
    })
    @ValidateIf((body) => !isFulfillmentUpdate(body))
    @IsDefined()
    @ValidateNested()
    @Type(() => OrderDeliveryDto)
    delivery?: OrderDeliveryDto;

    @ApiPropertyOptional({
        type: () => [OrderFulfillmentGroupDto],
        description:
            'Which storefront location fulfils which items, for a store that ' +
            'ships from more than one. Each group with `delivery_method` ' +
            '`shipping` or `local` becomes its own package, dispatched from ' +
            'the warehouse its location is mapped to through PUT ' +
            '/api/v1/integrations/locations; a group whose location is not ' +
            'mapped puts the event in `needs_attention` instead of falling ' +
            'back to another warehouse. On `order.paid`, every ' +
            '`line_items[].line_item_id` must reference an ' +
            '`order.line_items[].id`, or the event is rejected with 400; omit ' +
            'it, or send an empty array, to have the whole order dispatched ' +
            'as one package from the nearest warehouse. Required on ' +
            '`order.fulfillment_updated`, where it lists every group that is ' +
            'still to be delivered after the change (empty when none is): a ' +
            'package whose group now ships from another warehouse, or ' +
            'weighs something else, is replaced, and a group without a ' +
            'package gets one.',
    })
    @ValidateIf(
        (body: OrderEventDto) =>
            isFulfillmentUpdate(body) || body.fulfillment_groups != null,
    )
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OrderFulfillmentGroupDto)
    @Validate(FulfillmentLineItemsInOrderConstraint)
    fulfillment_groups?: OrderFulfillmentGroupDto[];

    @ApiPropertyOptional({
        type: [String],
        description:
            'Only on `order.fulfillment_updated`, and required there: the ids ' +
            'of groups whose items the storefront re-routed or cancelled, ' +
            'such as the group items were moved out of, groups merged into ' +
            'another, or a cancelled group. The package of a released group ' +
            'that is not in `fulfillment_groups` any more is taken off its ' +
            'shift and deleted. A group that is missing from ' +
            '`fulfillment_groups` without being released (fulfilled, for ' +
            'instance) keeps its package.',
    })
    @ValidateIf(
        (body: OrderEventDto) =>
            isFulfillmentUpdate(body) || body.released_group_ids != null,
    )
    @IsArray()
    @IsString({ each: true })
    @IsNotEmpty({ each: true })
    released_group_ids?: string[];
}

/** An `order.paid` body, which validation guarantees carries the whole order. */
export type OrderPaidPayload = OrderEventDto & {
    order: OrderInfoDto;
    customer: OrderEventCustomerDto;
    delivery: OrderDeliveryDto;
};
