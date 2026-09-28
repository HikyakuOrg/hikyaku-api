import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';

/**
 * What happens to the items a storefront fulfils from one of its locations.
 * Mirrors integration_location_mapping_mode_chk.
 */
export const LOCATION_MAPPING_MODES = [
    'warehouse',
    'not_delivered',
    'unmapped',
] as const;

export type LocationMappingMode = (typeof LOCATION_MAPPING_MODES)[number];

/** The most locations one PUT may carry. */
export const MAX_LOCATIONS_PER_UPSERT = 1000;

const MODE_DESCRIPTION =
    "`warehouse`: dispatch this location's items from `warehouse_id`. " +
    "`not_delivered`: Hikyaku does not deliver this location's items. " +
    '`unmapped`: not decided yet; its orders need attention.';

/** One storefront location in PUT /api/v1/integrations/locations. */
export class IntegrationLocationInputDto {
    @ApiProperty({
        description: "The location's id in the storefront's own system.",
        example: 'gid://shopify/Location/123',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    external_location_id: string;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description:
            'Display name, refreshed on every sync. Omit (or send null) to ' +
            'keep the stored name.',
        example: 'Melbourne warehouse',
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    external_location_name?: string | null;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description:
            'ISO 3166-1 alpha-2 country of the location, stored upper case. ' +
            'Omit (or send null) to keep the stored value.',
        example: 'AU',
    })
    @IsOptional()
    @Matches(/^[A-Za-z]{2}$/, {
        message: 'country_code must be an ISO 3166-1 alpha-2 code',
    })
    country_code?: string | null;

    @ApiPropertyOptional({
        enum: LOCATION_MAPPING_MODES,
        description:
            `${MODE_DESCRIPTION} Omit to leave an existing location's mode ` +
            'and warehouse as they are (a new one starts `unmapped`), which ' +
            'is how a connector refreshes names without undoing what the ' +
            'merchant chose.',
    })
    @IsOptional()
    @IsIn(LOCATION_MAPPING_MODES)
    mode?: LocationMappingMode;

    @ApiPropertyOptional({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'Required when `mode` is `warehouse`, and only then. Must be a ' +
            'warehouse of the organisation in `X-Organisation-Slug`.',
    })
    @IsOptional()
    @IsUUID()
    warehouse_id?: string | null;
}

/** Body of PUT /api/v1/integrations/locations. */
export class UpsertIntegrationLocationsDto {
    @ApiProperty({
        description:
            'Lowercase connector slug. An open value, never a closed enum, ' +
            'as on POST /api/v1/integrations/orders.',
        example: 'shopify',
    })
    @IsString()
    @Matches(/^[a-z0-9-]+$/, {
        message: 'platform must be a lowercase slug (a-z, 0-9, -)',
    })
    platform: string;

    @ApiProperty({
        description:
            'The storefront the locations belong to. Compared case ' +
            'insensitively and stored lower case.',
        example: 'store.myshopify.com',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    shop_domain: string;

    @ApiProperty({
        type: [IntegrationLocationInputDto],
        description: `Up to ${MAX_LOCATIONS_PER_UPSERT} locations, each at most once.`,
    })
    @IsArray()
    @ArrayMaxSize(MAX_LOCATIONS_PER_UPSERT)
    @ValidateNested({ each: true })
    @Type(() => IntegrationLocationInputDto)
    locations: IntegrationLocationInputDto[];

    @ApiPropertyOptional({
        default: false,
        description:
            '`true` when `locations` is every location the shop has right ' +
            'now: any stored location of this shop missing from it is marked ' +
            'stale (`stale_at`), keeping its mapping. Leave `false` to upsert ' +
            'a few locations without touching the rest.',
    })
    @IsOptional()
    @IsBoolean()
    mark_missing_stale?: boolean;
}

/** One stored storefront location and where its items ship from. */
export class IntegrationLocationDto {
    @ApiProperty({ format: 'uuid' })
    id: string;

    @ApiProperty({ example: 'shopify' })
    platform: string;

    @ApiProperty({ example: 'store.myshopify.com' })
    shop_domain: string;

    @ApiProperty({ example: 'gid://shopify/Location/123' })
    external_location_id: string;

    @ApiProperty({ type: String, nullable: true })
    external_location_name: string | null;

    @ApiProperty({ type: String, nullable: true, example: 'AU' })
    country_code: string | null;

    @ApiProperty({
        enum: LOCATION_MAPPING_MODES,
        description: MODE_DESCRIPTION,
    })
    mode: LocationMappingMode;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'Set exactly when `mode` is `warehouse`. Deleting the warehouse ' +
            'moves the location back to `unmapped`.',
    })
    warehouse_id: string | null;

    @ApiProperty({
        type: String,
        format: 'date-time',
        nullable: true,
        description:
            'When a full sync (`mark_missing_stale`) last left this location ' +
            'out. NULL while the storefront still reports it.',
    })
    stale_at: string | null;

    @ApiProperty({ format: 'date-time' })
    updated_at: string;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'User whose request last changed the row. NULL when the ' +
            'database changed it, e.g. after its warehouse was deleted.',
    })
    updated_by: string | null;
}

export class IntegrationLocationListDto {
    @ApiProperty({ type: [IntegrationLocationDto] })
    data: IntegrationLocationDto[];
}
