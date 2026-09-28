import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { WarehouseDto } from './dto/warehouse.dto';

interface WarehouseRow {
    id: string;
    name: string;
    address: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
    timezone: string;
    lon: number | string;
    lat: number | string;
}

/**
 * Reads `warehouse` for API-only clients, such as storefront connectors. The
 * dashboard reads warehouses through PostgREST.
 */
@Injectable()
export class WarehousesService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** Every warehouse of the organisation, by name. */
    async list(organisationId: string): Promise<WarehouseDto[]> {
        const rows: WarehouseRow[] = await this.dataSource.query(
            `SELECT id, warehouse_name AS name, warehouse_address AS address,
                    warehouse_city AS city, warehouse_state AS state,
                    warehouse_zipcode AS postcode, warehouse_country AS country,
                    timezone,
                    ST_X(warehouse_location::geometry) AS lon,
                    ST_Y(warehouse_location::geometry) AS lat
               FROM public.warehouse
              WHERE organisation_id = $1
              ORDER BY warehouse_name, id`,
            [organisationId],
        );
        return rows.map((row) => ({
            ...row,
            lon: Number(row.lon),
            lat: Number(row.lat),
        }));
    }
}
