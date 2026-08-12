import { ApiProperty } from '@nestjs/swagger';
import { PRICING_UNITS } from '../pricing';
import type {
    CatalogAddon,
    CatalogResponse,
    CatalogService,
} from '../services.service';

/**
 * Swagger view of the catalog contract in `services.service.ts` — the interfaces
 * there stay the source of truth for the service layer, and these classes exist
 * only so the document has a response schema (interfaces vanish at runtime, so
 * decorators need a class to hang off). `implements` keeps the two from drifting
 * apart: a field renamed or retyped in the interface fails the build here.
 *
 * Every field is read live from the org's Stripe products, not from a local
 * table: `id` is the Stripe product id, price and currency come from the
 * product's `default_price`, and `pricing_unit` from its metadata.
 */
export class CatalogAddonDto implements CatalogAddon {
    @ApiProperty({
        description:
            'Stripe product id — the stable public handle for this item. Editing ' +
            'a price mints a new Stripe price but leaves this unchanged.',
        example: 'prod_QhX1a2B3c4D5e6',
    })
    id: string;

    @ApiProperty({ example: 'Same-day courier' })
    name: string;

    @ApiProperty({
        enum: PRICING_UNITS,
        description:
            'How the booking quantity is derived at quote time. Read from Stripe ' +
            'product metadata, defaulting to `per_delivery` when absent.',
        example: 'per_km',
    })
    pricing_unit: string;

    @ApiProperty({
        description:
            'Per-unit rate in the currency’s minor units, e.g. 1250 for $12.50. ' +
            'The line total is this multiplied by the derived quantity.',
        example: 1250,
    })
    amount_minor: number;

    @ApiProperty({
        description: 'Lower-case ISO 4217 code, Stripe-style.',
        example: 'usd',
    })
    currency: string;
}

/** A bookable service plus the add-ons that can be selected alongside it. */
export class CatalogServiceDto
    extends CatalogAddonDto
    implements CatalogService
{
    @ApiProperty({
        type: [CatalogAddonDto],
        description:
            'Add-ons belonging to this service, oldest first. Only these are ' +
            'accepted in `addonIds` when quoting or paying for it.',
    })
    addons: CatalogAddonDto[];
}

/** 200 body of GET /api/v1/services/catalog. */
export class ServiceCatalogDto implements CatalogResponse {
    @ApiProperty({
        type: [CatalogServiceDto],
        description:
            'The organisation’s bookable services, oldest first. Empty when the ' +
            'organisation has not connected a Stripe account, or when no ' +
            '`x-org-slug` was supplied.',
    })
    services: CatalogServiceDto[];
}

/**
 * 200 body of every service/add-on write (create and update, for both). The
 * catalog itself is re-read from Stripe, so a mutation only echoes the handle it
 * affected.
 */
export class ServiceRefDto {
    @ApiProperty({
        description:
            'Stripe product id of the created or updated item. Stable across ' +
            'price edits.',
        example: 'prod_QhX1a2B3c4D5e6',
    })
    id: string;
}
