import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import type {
    IntegrationLocationDto,
    IntegrationLocationInputDto,
    LocationMappingMode,
    UpsertIntegrationLocationsDto,
} from './dto/integration-location.dto';

interface MappingRow {
    id: string;
    platform: string;
    shop_domain: string;
    external_location_id: string;
    external_location_name: string | null;
    country_code: string | null;
    mode: LocationMappingMode;
    warehouse_id: string | null;
    stale_at: string | Date | null;
    updated_at: string | Date;
    updated_by: string | null;
}

/** One location as it is written, after validation and normalising. */
interface LocationWrite {
    external_location_id: string;
    external_location_name: string | null;
    country_code: string | null;
    mode: LocationMappingMode | null;
    warehouse_id: string | null;
}

const MAPPING_COLS = `id, platform, shop_domain, external_location_id,
    external_location_name, country_code, mode, warehouse_id, stale_at,
    updated_at, updated_by`;

const ORDER_BY = `ORDER BY platform, shop_domain, stale_at IS NOT NULL,
    external_location_name NULLS LAST, external_location_id`;

/**
 * Which Hikyaku warehouse dispatches the items a storefront fulfils from each
 * of its locations, stored in `integration_location_mapping`. Connectors
 * register their locations here and the merchant maps each one; order
 * processing reads it back to pick the dispatching warehouse.
 *
 * Every query carries an explicit organisation_id predicate: this runs as
 * service_role, so RLS is not what keeps tenants apart.
 */
@Injectable()
export class LocationMappingsService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** Stored locations, optionally narrowed to one platform and/or shop. */
    async list(
        organisationId: string,
        filter: { platform?: string; shopDomain?: string },
    ): Promise<IntegrationLocationDto[]> {
        const rows: MappingRow[] = await this.dataSource.query(
            `SELECT ${MAPPING_COLS} FROM public.integration_location_mapping
              WHERE organisation_id = $1
                AND ($2::text IS NULL OR platform = $2)
                AND ($3::text IS NULL OR shop_domain = $3)
              ${ORDER_BY}`,
            [
                organisationId,
                filter.platform ?? null,
                filter.shopDomain
                    ? normaliseShopDomain(filter.shopDomain)
                    : null,
            ],
        );
        return rows.map(toDto);
    }

    /**
     * Upserts one shop's locations and returns every stored location of that
     * shop afterwards, stale ones included.
     *
     * A location sent without `mode` keeps its stored mode and warehouse
     * (a new one starts `unmapped`), so a connector can refresh names and
     * countries without undoing the merchant's choices. Every location sent
     * counts as reported, which clears its `stale_at`. With
     * `mark_missing_stale`, the shop's other locations are marked stale
     * rather than deleted: orders placed before a location closed can still
     * arrive, and it may come back.
     *
     * A warehouse id that is not one of this organisation's warehouses is a
     * 404, the same answer as one that does not exist at all, so the caller
     * learns nothing about other organisations.
     */
    async upsert(
        organisationId: string,
        userId: string,
        dto: UpsertIntegrationLocationsDto,
    ): Promise<IntegrationLocationDto[]> {
        const shopDomain = normaliseShopDomain(dto.shop_domain);
        if (shopDomain === '') {
            throw new BadRequestException('shop_domain should not be empty');
        }
        const locations = dto.locations.map(toWrite);
        assertUniqueIds(locations);
        await this.assertOwnWarehouses(organisationId, locations);

        const scope = [organisationId, dto.platform, shopDomain, userId];
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            const withMode = locations.filter((l) => l.mode !== null);
            const withoutMode = locations.filter((l) => l.mode === null);
            if (withMode.length > 0) {
                await runner.query(upsertSql(true), [
                    ...scope,
                    JSON.stringify(withMode),
                ]);
            }
            if (withoutMode.length > 0) {
                await runner.query(upsertSql(false), [
                    ...scope,
                    JSON.stringify(withoutMode),
                ]);
            }
            if (dto.mark_missing_stale) {
                await this.markMissingStale(
                    runner,
                    scope,
                    locations.map((l) => l.external_location_id),
                );
            }
            const rows = (await runner.query(
                `SELECT ${MAPPING_COLS} FROM public.integration_location_mapping
                  WHERE organisation_id = $1 AND platform = $2 AND shop_domain = $3
                  ${ORDER_BY}`,
                scope.slice(0, 3),
            )) as MappingRow[];
            await runner.commitTransaction();
            return rows.map(toDto);
        } catch (err) {
            if (runner.isTransactionActive) await runner.rollbackTransaction();
            // The composite warehouse foreign key: the warehouse was deleted
            // between assertOwnWarehouses and the write.
            if ((err as { code?: string })?.code === '23503') {
                throw new NotFoundException(
                    'A warehouse in this request no longer exists in this organisation.',
                );
            }
            throw err;
        } finally {
            await runner.release();
        }
    }

    /**
     * One query for every warehouse id in the request. The composite foreign
     * key refuses another organisation's warehouse on its own; checking here
     * first turns that into a 404 naming the ids instead of a 500.
     */
    private async assertOwnWarehouses(
        organisationId: string,
        locations: LocationWrite[],
    ): Promise<void> {
        const ids = [
            ...new Set(
                locations
                    .map((l) => l.warehouse_id)
                    .filter((id): id is string => id !== null),
            ),
        ];
        if (ids.length === 0) return;

        const found: { id: string }[] = await this.dataSource.query(
            `SELECT id FROM public.warehouse
              WHERE organisation_id = $1 AND id = ANY($2::uuid[])`,
            [organisationId, ids],
        );
        const known = new Set(found.map((row) => row.id));
        const missing = ids.filter((id) => !known.has(id));
        if (missing.length > 0) {
            throw new NotFoundException(
                `No warehouse in this organisation with id ${missing.join(', ')}.`,
            );
        }
    }

    private async markMissingStale(
        runner: QueryRunner,
        scope: unknown[],
        reportedIds: string[],
    ): Promise<void> {
        await runner.query(
            `UPDATE public.integration_location_mapping
                SET stale_at = now(), updated_at = now(), updated_by = $4::uuid
              WHERE organisation_id = $1 AND platform = $2 AND shop_domain = $3
                AND stale_at IS NULL
                AND NOT (external_location_id = ANY($5::text[]))`,
            [...scope, reportedIds],
        );
    }
}

/**
 * The INSERT ... ON CONFLICT for one batch. `setMode` decides whether an
 * existing row's mode and warehouse are overwritten; without it they are left
 * alone and only a new row takes the `unmapped` default. Name and country
 * fall back to the stored value when the caller sends none. The WHERE on the
 * update skips rows the request would not change, so a connector re-syncing
 * the same list does not rewrite updated_at on every call.
 */
function upsertSql(setMode: boolean): string {
    const name =
        'COALESCE(EXCLUDED.external_location_name, m.external_location_name)';
    const country = 'COALESCE(EXCLUDED.country_code, m.country_code)';
    const modeSet = setMode
        ? 'mode = EXCLUDED.mode, warehouse_id = EXCLUDED.warehouse_id,'
        : '';
    const modeCols = setMode ? ', m.mode, m.warehouse_id' : '';
    const modeVals = setMode ? ', EXCLUDED.mode, EXCLUDED.warehouse_id' : '';
    return `INSERT INTO public.integration_location_mapping AS m
                (organisation_id, platform, shop_domain, external_location_id,
                 external_location_name, country_code, mode, warehouse_id, updated_by)
            SELECT $1::uuid, $2, $3, l.external_location_id, l.external_location_name,
                   l.country_code, COALESCE(l.mode, 'unmapped'), l.warehouse_id, $4::uuid
              FROM jsonb_to_recordset($5::jsonb) AS l(
                   external_location_id text, external_location_name text,
                   country_code text, mode text, warehouse_id uuid)
            ON CONFLICT (organisation_id, platform, shop_domain, external_location_id)
            DO UPDATE SET
                external_location_name = ${name},
                country_code = ${country},
                ${modeSet}
                stale_at = NULL,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by
            WHERE (m.external_location_name, m.country_code${modeCols}, m.stale_at)
                IS DISTINCT FROM (${name}, ${country}${modeVals}, NULL::timestamptz)`;
}

/**
 * Validates the mode/warehouse pairing the database CHECK also enforces, so
 * the caller gets a 400 that says which location is wrong rather than a 500.
 */
function toWrite(location: IntegrationLocationInputDto): LocationWrite {
    const mode = location.mode ?? null;
    const warehouseId = location.warehouse_id ?? null;
    const id = location.external_location_id;
    if (mode === 'warehouse' && warehouseId === null) {
        throw new BadRequestException(
            `Location ${id}: mode "warehouse" needs a warehouse_id.`,
        );
    }
    if (mode !== 'warehouse' && warehouseId !== null) {
        throw new BadRequestException(
            `Location ${id}: warehouse_id is only allowed with mode "warehouse".`,
        );
    }
    return {
        external_location_id: id,
        external_location_name: location.external_location_name ?? null,
        country_code: location.country_code?.toUpperCase() ?? null,
        mode,
        warehouse_id: warehouseId,
    };
}

/** A location twice in one INSERT ... ON CONFLICT is a Postgres error. */
function assertUniqueIds(locations: LocationWrite[]): void {
    const seen = new Set<string>();
    for (const { external_location_id: id } of locations) {
        if (seen.has(id)) {
            throw new BadRequestException(
                `Location ${id} appears more than once.`,
            );
        }
        seen.add(id);
    }
}

function normaliseShopDomain(domain: string): string {
    return domain.trim().toLowerCase();
}

function toIso(value: string | Date): string {
    return new Date(value).toISOString();
}

function toDto(row: MappingRow): IntegrationLocationDto {
    return {
        id: row.id,
        platform: row.platform,
        shop_domain: row.shop_domain,
        external_location_id: row.external_location_id,
        external_location_name: row.external_location_name,
        country_code: row.country_code,
        mode: row.mode,
        warehouse_id: row.warehouse_id,
        stale_at: row.stale_at ? toIso(row.stale_at) : null,
        updated_at: toIso(row.updated_at),
        updated_by: row.updated_by,
    };
}
