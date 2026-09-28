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

/** Mirrors integration_location_mapping_mode_chk. */
export const LOCATION_MAPPING_MODES = [
    'warehouse',
    'not_delivered',
    'unmapped',
] as const;

export type LocationMappingMode = (typeof LOCATION_MAPPING_MODES)[number];

/** The most locations one PUT may carry. */
export const MAX_LOCATIONS_PER_UPSERT = 1000;

const MODE_DESCRIPTION =
    '`warehouse`: ship from `warehouse_id`. ' +
    '`not_delivered`: Hikyaku does not deliver these items. ' +
    '`unmapped`: not decided; orders need attention.';

/** One storefront location in PUT /api/v1/integrations/locations. */
export class IntegrationLocationInputDto {
    @ApiProperty({
        description: "The location's storefront id.",
        example: 'gid://shopify/Location/123',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    external_location_id: string;

    @ApiPropertyOptional({
        type: String,
        nullable: true,
        description: 'Display name. Omit or send null to keep the stored name.',
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
            'ISO 3166-1 alpha-2, stored upper case. Omit or send null to keep ' +
            'the stored value.',
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
            `${MODE_DESCRIPTION} Omit to keep the stored mode and warehouse ` +
            '(a new location starts `unmapped`).',
    })
    @IsOptional()
    @IsIn(LOCATION_MAPPING_MODES)
    mode?: LocationMappingMode;

    @ApiPropertyOptional({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'Required when `mode` is `warehouse`, and only then. Must belong ' +
            'to the organisation in `X-Organisation-Slug`.',
    })
    @IsOptional()
    @IsUUID()
    warehouse_id?: string | null;
}

/** Body of PUT /api/v1/integrations/locations. */
export class UpsertIntegrationLocationsDto {
    @ApiProperty({
        description:
            'Lowercase connector slug, as on POST /api/v1/integrations/orders.',
        example: 'shopify',
    })
    @IsString()
    @Matches(/^[a-z0-9-]+$/, {
        message: 'platform must be a lowercase slug (a-z, 0-9, -)',
    })
    platform: string;

    @ApiProperty({
        description: 'Storefront domain. Case-insensitive; stored lower case.',
        example: 'store.myshopify.com',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    shop_domain: string;

    @ApiProperty({
        type: [IntegrationLocationInputDto],
        description: `Up to ${MAX_LOCATIONS_PER_UPSERT} locations, no duplicates.`,
    })
    @IsArray()
    @ArrayMaxSize(MAX_LOCATIONS_PER_UPSERT)
    @ValidateNested({ each: true })
    @Type(() => IntegrationLocationInputDto)
    locations: IntegrationLocationInputDto[];

    @ApiPropertyOptional({
        default: false,
        description:
            "Set `true` when `locations` is the shop's full list. Stored " +
            'locations missing from it get `stale_at` and keep their mapping.',
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
            'Set only when `mode` is `warehouse`. Deleting the warehouse sets ' +
            '`mode` to `unmapped`.',
    })
    warehouse_id: string | null;

    @ApiProperty({
        type: String,
        format: 'date-time',
        nullable: true,
        description:
            'When a full sync (`mark_missing_stale`) last omitted this ' +
            'location. NULL while the storefront reports it.',
    })
    stale_at: string | null;

    @ApiProperty({ format: 'date-time' })
    updated_at: string;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'User who last changed the row. NULL for a database change, such ' +
            'as a warehouse delete.',
    })
    updated_by: string | null;
}

export class IntegrationLocationListDto {
    @ApiProperty({ type: [IntegrationLocationDto] })
    data: IntegrationLocationDto[];
}
