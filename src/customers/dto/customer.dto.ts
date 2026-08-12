import { ApiProperty } from '@nestjs/swagger';
import type { CustomerRow } from '../customers.service';

/**
 * Swagger view of the customer contract in `customers.service.ts`. The interface
 * there stays the source of truth; `implements` is what stops the two drifting.
 *
 * Field names are the raw `customer` table columns, so they are snake_case and
 * `customer_`-prefixed — deliberately unchanged, since the dashboard already
 * consumes them that way.
 */
export class CustomerLocationDto {
    @ApiProperty({ enum: ['Point'], example: 'Point' })
    type: 'Point';

    @ApiProperty({
        type: [Number],
        minItems: 2,
        maxItems: 2,
        description: 'GeoJSON order: [longitude, latitude].',
        example: [103.8607, 1.2834],
    })
    coordinates: [number, number];
}

export class CustomerDto implements CustomerRow {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ format: 'uuid' })
    organisation_id: string;

    // `type` is explicit on every nullable field: a bare `string | null` reflects
    // as Object, which the generator turns into an untyped `any`.
    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'Linked Stripe customer on the organisation’s connected account. Null ' +
            'until the organisation enables payments, and null if the ' +
            'best-effort Stripe sync failed.',
        example: 'cus_QhX1a2B3c4D5e6',
    })
    stripe_customer_id: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Set only for customers created from a Shopify order.',
    })
    shopify_customer_id: string | null;

    @ApiProperty({
        description: 'Empty string when the column is null, never null itself.',
    })
    customer_name: string;

    @ApiProperty({ description: 'E.164 where known. Empty string when unset.' })
    customer_phone: string;

    @ApiProperty({ description: 'Empty string when unset.' })
    customer_email: string;

    @ApiProperty({ description: 'Street line. Empty string when unset.' })
    customer_address: string;

    @ApiProperty({ description: 'Empty string when unset.' })
    customer_suburb: string;

    @ApiProperty({ description: 'Empty string when unset.' })
    customer_state: string;

    @ApiProperty({ description: 'Empty string when unset.' })
    customer_postcode: string;

    @ApiProperty({ description: 'Empty string when unset.' })
    customer_country: string;

    @ApiProperty({
        type: Number,
        nullable: true,
        description:
            'Pelias geocode confidence (0–1). Only set for addresses entered ' +
            'through the geocoded manual-entry form.',
    })
    geocode_confidence: number | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Pelias global id, for stable re-lookup of the address.',
    })
    pelias_gid: string | null;

    @ApiProperty({
        type: 'object',
        additionalProperties: true,
        nullable: true,
        description:
            'Raw Pelias feature kept for provenance. Opaque — do not read fields ' +
            'off it.',
    })
    pelias_raw: unknown | null;

    @ApiProperty({
        type: CustomerLocationDto,
        nullable: true,
        description: 'Geocoded position as GeoJSON.',
    })
    customer_location: { type: 'Point'; coordinates: [number, number] } | null;

    @ApiProperty({ format: 'date-time' })
    created_at: string;
}

/**
 * 200 body of GET /api/v1/customers.
 *
 * Declared as a concrete class rather than a generic `PaginatedDto<T>`: this is
 * the only paginated endpoint on the API — `GET /issuing/cards` and
 * `GET /issuing/transactions` return bare arrays — and a named class generates a
 * plain interface downstream instead of the `allOf` composition a generic
 * produces. Introduce the generic when there is a second one to share it with.
 */
export class PaginatedCustomersDto {
    @ApiProperty({
        type: [CustomerDto],
        description:
            'One page of customers, newest first. Shorter than `pageSize` on the ' +
            'last page, and empty past the end.',
    })
    data: CustomerDto[];

    @ApiProperty({
        description:
            'Total customers in the organisation, ignoring pagination — divide by ' +
            '`pageSize` for the page count.',
        example: 137,
    })
    total: number;
}
