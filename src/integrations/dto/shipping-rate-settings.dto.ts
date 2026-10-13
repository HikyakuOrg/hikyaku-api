import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
} from 'class-validator';
import { PRICING_UNITS } from 'src/services/pricing';

/** Mirrors integration_shipping_rate_settings_path_chk. */
export const SHIPPING_RATE_PATHS = ['live', 'static'] as const;
export type ShippingRatePath = (typeof SHIPPING_RATE_PATHS)[number];

/** The most services one shop can offer as rates. */
export const MAX_RATE_SERVICES = 20;

/** Error codes a 422 from PUT /api/v1/integrations/shipping-rates carries. */
export const SHIPPING_RATE_ERROR_CODES = [
    'stripe_not_connected',
    'no_services',
    'service_missing_currency',
    'unknown_service',
    'band_settings_invalid',
] as const;
export type ShippingRateErrorCode = (typeof SHIPPING_RATE_ERROR_CODES)[number];

/** Band size for one static-path service, in the service's own unit. */
export class BandSettingDto {
    @ApiProperty({
        description:
            'Band size in the service unit: km for per_km, mi for per_mi, kg ' +
            'for per_kg, lb for per_lb.',
        example: 5,
    })
    band_width: number;

    @ApiProperty({
        description:
            'Largest distance or weight offered, same unit. Above it the ' +
            'shopper gets no Hikyaku rate.',
        example: 30,
    })
    max: number;
}

/** A shop's stored rate settings. */
export class ShippingRateSettingsDto {
    @ApiProperty({ description: 'Rates are offered at checkout.' })
    enabled: boolean;

    @ApiProperty({
        type: [String],
        description:
            'Stripe product ids of the catalog services offered, in display ' +
            'order.',
        example: ['prod_QhX1a2B3c4D5e6'],
    })
    service_ids: string[];

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Upper-case ISO 4217 currency of the shop.',
        example: 'AUD',
    })
    shop_currency: string | null;

    @ApiProperty({
        enum: SHIPPING_RATE_PATHS,
        nullable: true,
        description:
            '`live`: the storefront asks per checkout. `static`: rates are ' +
            'written into the storefront.',
    })
    path: ShippingRatePath | null;

    @ApiProperty({
        type: 'object',
        additionalProperties: { $ref: '#/components/schemas/BandSettingDto' },
        description: 'Static path band sizes by service id.',
    })
    band_settings: Record<string, BandSettingDto>;
}

/** A catalog service as the rate settings screen lists it. */
export class ShippingRateServiceDto {
    @ApiProperty({ description: 'Stripe product id.' })
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty({ type: String, nullable: true })
    description: string | null;

    @ApiProperty({ enum: PRICING_UNITS })
    unit: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'Per-unit rate in `currency` as a decimal string, e.g. "1.50". ' +
            'Null when the price has no amount in that currency; such a ' +
            'service cannot be enabled.',
        example: '1.50',
    })
    amount: string | null;

    @ApiProperty({
        description: 'Upper-case ISO 4217 currency `amount` is in.',
        example: 'AUD',
    })
    currency: string;
}

export class ShippingRateSettingsViewDto {
    @ApiProperty({
        type: ShippingRateSettingsDto,
        description:
            'Stored settings, or the defaults (disabled, no services) when ' +
            'none are stored.',
    })
    settings: ShippingRateSettingsDto;

    @ApiProperty({
        description: 'The organisation has a Stripe account connected.',
    })
    stripe_connected: boolean;

    @ApiProperty({ type: [ShippingRateServiceDto] })
    services: ShippingRateServiceDto[];

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'Dashboard page where a merchant adds a price in another ' +
            'currency. Null when the API has no dashboard URL configured.',
    })
    dashboard_service_url: string | null;
}

export class ShippingRateSettingsViewResponseDto {
    @ApiProperty({ type: ShippingRateSettingsViewDto })
    data: ShippingRateSettingsViewDto;
}

/** Body of PUT /api/v1/integrations/shipping-rates. */
export class PutShippingRateSettingsDto {
    @ApiProperty({ example: 'shopify' })
    @IsString()
    @Matches(/^[a-z0-9-]+$/, {
        message: 'platform must be a lowercase slug (a-z, 0-9, -)',
    })
    platform: string;

    @ApiProperty({ example: 'store.myshopify.com' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    shop_domain: string;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description: 'ISO 4217, any case. Required to enable.',
        example: 'AUD',
    })
    @IsOptional()
    @Matches(/^[A-Za-z]{3}$/, {
        message: 'shop_currency must be a three-letter ISO 4217 code',
    })
    shop_currency?: string | null;

    @ApiProperty()
    @IsBoolean()
    enabled: boolean;

    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMaxSize(MAX_RATE_SERVICES)
    @IsString({ each: true })
    service_ids: string[];

    @ApiPropertyOptional({ enum: SHIPPING_RATE_PATHS, nullable: true })
    @IsOptional()
    @IsIn(SHIPPING_RATE_PATHS)
    path?: ShippingRatePath | null;

    @ApiPropertyOptional({
        type: 'object',
        additionalProperties: { $ref: '#/components/schemas/BandSettingDto' },
        description:
            'Required for each distance and weight service when `path` is ' +
            '`static` and rates are enabled. Entries for other services are ' +
            'dropped.',
    })
    @IsOptional()
    @IsObject()
    band_settings?: Record<string, BandSettingDto>;
}

export class ShippingRateSettingsResponseDto {
    @ApiProperty({ type: ShippingRateSettingsDto })
    data: ShippingRateSettingsDto;
}

/** 422 body of PUT /api/v1/integrations/shipping-rates. */
export class ShippingRateErrorDto {
    @ApiProperty({ example: 422 })
    statusCode: number;

    @ApiProperty({ example: 'Same-day has no price in AUD.' })
    message: string;

    @ApiProperty({ enum: SHIPPING_RATE_ERROR_CODES })
    code: ShippingRateErrorCode;

    @ApiPropertyOptional({
        type: [String],
        description: 'The services the error is about.',
    })
    service_ids?: string[];
}
