import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsArray,
    IsBoolean,
    IsISO8601,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    ValidateNested,
} from 'class-validator';

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
            'Event type, e.g. "order.paid". An open string, not a closed ' +
            'enum, so a connector can introduce a new event type without a ' +
            'hikyaku-api change.',
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

export class OrderEventDto {
    @ApiProperty({ type: () => OrderEventInfoDto })
    @ValidateNested()
    @Type(() => OrderEventInfoDto)
    event: OrderEventInfoDto;

    @ApiProperty({ type: () => OrderEventSourceDto })
    @ValidateNested()
    @Type(() => OrderEventSourceDto)
    source: OrderEventSourceDto;

    @ApiProperty({ type: () => OrderInfoDto })
    @ValidateNested()
    @Type(() => OrderInfoDto)
    order: OrderInfoDto;

    @ApiProperty({ type: () => OrderEventCustomerDto })
    @ValidateNested()
    @Type(() => OrderEventCustomerDto)
    customer: OrderEventCustomerDto;

    @ApiProperty({ type: () => OrderDeliveryDto })
    @ValidateNested()
    @Type(() => OrderDeliveryDto)
    delivery: OrderDeliveryDto;
}
