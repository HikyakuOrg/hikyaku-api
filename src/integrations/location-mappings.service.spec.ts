import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LocationMappingsService } from './location-mappings.service';
import {
    LOCATION_MAPPING_MODES,
    type LocationMappingMode,
    type UpsertIntegrationLocationsDto,
} from './dto/integration-location.dto';

const ORG = 'org-1';
const USER = 'user-1';
const WAREHOUSE = 'b6ef9918-3656-48f9-bf72-48dba1df4625';
const OTHER_WAREHOUSE = 'c6f7a95b-c9cd-4037-9581-e05caf060049';

const storedRow = {
    id: 'map-1',
    platform: 'shopify',
    shop_domain: 'store.myshopify.com',
    external_location_id: 'gid://shopify/Location/1',
    external_location_name: 'Melbourne',
    country_code: 'AU',
    mode: 'warehouse',
    warehouse_id: WAREHOUSE,
    stale_at: null,
    updated_at: new Date('2026-09-28T01:00:00.000Z'),
    updated_by: USER,
};

describe('LocationMappingsService', () => {
    let service: LocationMappingsService;
    let dataSource: {
        query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
        createQueryRunner: jest.Mock;
    };
    let runner: {
        connect: jest.Mock;
        startTransaction: jest.Mock;
        commitTransaction: jest.Mock;
        rollbackTransaction: jest.Mock;
        release: jest.Mock;
        query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
        isTransactionActive: boolean;
    };

    beforeEach(async () => {
        runner = {
            connect: jest.fn(),
            startTransaction: jest.fn(),
            commitTransaction: jest.fn(),
            rollbackTransaction: jest.fn(),
            release: jest.fn(),
            query: jest.fn<Promise<unknown>, [string, unknown[]?]>(),
            isTransactionActive: true,
        };
        dataSource = {
            query: jest.fn<Promise<unknown[]>, [string, unknown[]?]>(),
            createQueryRunner: jest.fn(() => runner),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LocationMappingsService,
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();

        service = module.get<LocationMappingsService>(LocationMappingsService);
    });

    /** Every statement the transaction ran, in order. */
    const runnerSql = (): string[] =>
        runner.query.mock.calls.map(([sql]) => sql);

    describe('list', () => {
        it('scopes to the organisation and maps rows to the DTO', async () => {
            dataSource.query.mockResolvedValueOnce([storedRow]);

            const result = await service.list(ORG, {});

            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain('WHERE organisation_id = $1');
            expect(params).toEqual([ORG, null, null]);
            expect(result).toEqual([
                {
                    ...storedRow,
                    updated_at: '2026-09-28T01:00:00.000Z',
                },
            ]);
        });

        it('narrows to a platform and a shop, matching the domain case insensitively', async () => {
            dataSource.query.mockResolvedValueOnce([]);

            await service.list(ORG, {
                platform: 'shopify',
                shopDomain: ' Store.MyShopify.com ',
            });

            expect(dataSource.query.mock.calls[0][1]).toEqual([
                ORG,
                'shopify',
                'store.myshopify.com',
            ]);
        });
    });

    describe('upsert', () => {
        const dto = (
            locations: UpsertIntegrationLocationsDto['locations'],
            extra: Partial<UpsertIntegrationLocationsDto> = {},
        ): UpsertIntegrationLocationsDto => ({
            platform: 'shopify',
            shop_domain: 'Store.MyShopify.com',
            locations,
            ...extra,
        });

        it('writes a location with a mode, mode and warehouse included, in one transaction scoped to the org and shop', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: WAREHOUSE }]); // warehouse check
            runner.query
                .mockResolvedValueOnce([]) // upsert
                .mockResolvedValueOnce([storedRow]); // read back

            const result = await service.upsert(
                ORG,
                USER,
                dto([
                    {
                        external_location_id: 'gid://shopify/Location/1',
                        external_location_name: 'Melbourne',
                        country_code: 'au',
                        mode: 'warehouse',
                        warehouse_id: WAREHOUSE,
                    },
                ]),
            );

            const [upsertSql, upsertParams] = runner.query.mock.calls[0];
            expect(upsertSql).toContain(
                'ON CONFLICT (organisation_id, platform, shop_domain, external_location_id)',
            );
            expect(upsertSql).toContain(
                'mode = EXCLUDED.mode, warehouse_id = EXCLUDED.warehouse_id',
            );
            expect(upsertSql).toContain('stale_at = NULL');
            expect(upsertParams?.slice(0, 4)).toEqual([
                ORG,
                'shopify',
                'store.myshopify.com',
                USER,
            ]);
            expect(JSON.parse(upsertParams?.[4] as string)).toEqual([
                {
                    external_location_id: 'gid://shopify/Location/1',
                    external_location_name: 'Melbourne',
                    country_code: 'AU',
                    mode: 'warehouse',
                    warehouse_id: WAREHOUSE,
                },
            ]);

            const [readSql, readParams] = runner.query.mock.calls[1];
            expect(readSql).toContain(
                'WHERE organisation_id = $1 AND platform = $2 AND shop_domain = $3',
            );
            expect(readParams).toEqual([ORG, 'shopify', 'store.myshopify.com']);

            expect(runner.commitTransaction).toHaveBeenCalled();
            expect(runner.release).toHaveBeenCalled();
            expect(result).toHaveLength(1);
        });

        it('leaves an existing mode and warehouse alone when a location is sent without a mode', async () => {
            runner.query
                .mockResolvedValueOnce([]) // upsert
                .mockResolvedValueOnce([storedRow]); // read back

            await service.upsert(
                ORG,
                USER,
                dto([
                    {
                        external_location_id: 'gid://shopify/Location/1',
                        external_location_name: 'Melbourne DC',
                        country_code: 'AU',
                    },
                ]),
            );

            // No warehouse to check, so no lookup outside the transaction.
            expect(dataSource.query).not.toHaveBeenCalled();

            const [upsertSql, upsertParams] = runner.query.mock.calls[0];
            expect(upsertSql).not.toMatch(/\bmode = EXCLUDED\.mode/);
            expect(upsertSql).not.toMatch(/warehouse_id = EXCLUDED/);
            // A new row still takes the default.
            expect(upsertSql).toContain("COALESCE(l.mode, 'unmapped')");
            expect(JSON.parse(upsertParams?.[4] as string)).toEqual([
                expect.objectContaining({ mode: null, warehouse_id: null }),
            ]);
        });

        it('splits a mixed batch into one write that sets the mode and one that keeps it', async () => {
            runner.query.mockResolvedValue([]);

            await service.upsert(
                ORG,
                USER,
                dto([
                    { external_location_id: 'a', mode: 'not_delivered' },
                    { external_location_id: 'b' },
                ]),
            );

            const [setMode, keepMode] = runner.query.mock.calls;
            expect(setMode[0]).toContain('mode = EXCLUDED.mode');
            expect(JSON.parse(setMode[1]?.[4] as string)).toEqual([
                expect.objectContaining({ external_location_id: 'a' }),
            ]);
            expect(keepMode[0]).not.toContain('mode = EXCLUDED.mode');
            expect(JSON.parse(keepMode[1]?.[4] as string)).toEqual([
                expect.objectContaining({ external_location_id: 'b' }),
            ]);
        });

        it("marks the shop's unreported locations stale, never deleting them, when asked to", async () => {
            runner.query.mockResolvedValue([]);

            await service.upsert(
                ORG,
                USER,
                dto(
                    [
                        { external_location_id: 'a' },
                        { external_location_id: 'b' },
                    ],
                    { mark_missing_stale: true },
                ),
            );

            const staleCall = runner.query.mock.calls.find(([sql]) =>
                sql.includes('SET stale_at = now()'),
            );
            expect(staleCall).toBeDefined();
            const [staleSql, staleParams] = staleCall!;
            expect(staleSql).toContain(
                'WHERE organisation_id = $1 AND platform = $2 AND shop_domain = $3',
            );
            expect(staleSql).toContain(
                'NOT (external_location_id = ANY($5::text[]))',
            );
            expect(staleSql).toContain('AND stale_at IS NULL');
            expect(staleParams).toEqual([
                ORG,
                'shopify',
                'store.myshopify.com',
                USER,
                ['a', 'b'],
            ]);
            expect(runnerSql().some((sql) => /\bDELETE\b/.test(sql))).toBe(
                false,
            );
        });

        it('marks every location of the shop stale for an empty full sync', async () => {
            runner.query.mockResolvedValue([]);

            await service.upsert(
                ORG,
                USER,
                dto([], { mark_missing_stale: true }),
            );

            // No upsert to run, only the stale marking and the read back.
            expect(runner.query).toHaveBeenCalledTimes(2);
            expect(runner.query.mock.calls[0][0]).toContain(
                'SET stale_at = now()',
            );
            expect(runner.query.mock.calls[0][1]?.[4]).toEqual([]);
        });

        it('touches no other location without mark_missing_stale', async () => {
            runner.query.mockResolvedValue([]);

            await service.upsert(
                ORG,
                USER,
                dto([{ external_location_id: 'a' }]),
            );

            expect(
                runnerSql().some((sql) => sql.includes('SET stale_at = now()')),
            ).toBe(false);
        });

        it("rejects another organisation's warehouse with 404 before writing anything", async () => {
            // The lookup is scoped to the caller's org, so the other org's
            // warehouse is not found.
            dataSource.query.mockResolvedValueOnce([]);

            await expect(
                service.upsert(
                    ORG,
                    USER,
                    dto([
                        {
                            external_location_id: 'a',
                            mode: 'warehouse',
                            warehouse_id: OTHER_WAREHOUSE,
                        },
                    ]),
                ),
            ).rejects.toThrow(
                new NotFoundException(
                    `No warehouse in this organisation with id ${OTHER_WAREHOUSE}.`,
                ),
            );

            const [sql, params] = dataSource.query.mock.calls[0];
            expect(sql).toContain(
                'WHERE organisation_id = $1 AND id = ANY($2::uuid[])',
            );
            expect(params).toEqual([ORG, [OTHER_WAREHOUSE]]);
            expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
        });

        it('checks each distinct warehouse once', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: WAREHOUSE }]);
            runner.query.mockResolvedValue([]);

            await service.upsert(
                ORG,
                USER,
                dto([
                    {
                        external_location_id: 'a',
                        mode: 'warehouse',
                        warehouse_id: WAREHOUSE,
                    },
                    {
                        external_location_id: 'b',
                        mode: 'warehouse',
                        warehouse_id: WAREHOUSE,
                    },
                ]),
            );

            expect(dataSource.query.mock.calls[0][1]).toEqual([
                ORG,
                [WAREHOUSE],
            ]);
        });

        it('turns a warehouse deleted mid-request (foreign key violation) into a 404 and rolls back', async () => {
            dataSource.query.mockResolvedValueOnce([{ id: WAREHOUSE }]);
            runner.query.mockRejectedValueOnce({ code: '23503' });

            await expect(
                service.upsert(
                    ORG,
                    USER,
                    dto([
                        {
                            external_location_id: 'a',
                            mode: 'warehouse',
                            warehouse_id: WAREHOUSE,
                        },
                    ]),
                ),
            ).rejects.toBeInstanceOf(NotFoundException);

            expect(runner.rollbackTransaction).toHaveBeenCalled();
            expect(runner.commitTransaction).not.toHaveBeenCalled();
            expect(runner.release).toHaveBeenCalled();
        });

        it('rethrows any other database error after rolling back', async () => {
            runner.query.mockRejectedValueOnce({ code: '40001' });

            await expect(
                service.upsert(ORG, USER, dto([{ external_location_id: 'a' }])),
            ).rejects.toEqual({ code: '40001' });
            expect(runner.rollbackTransaction).toHaveBeenCalled();
        });

        describe('mode and warehouse_id have to agree, as the CHECK constraint says', () => {
            it.each([
                ['warehouse without a warehouse_id', { mode: 'warehouse' }],
                [
                    'warehouse with a null warehouse_id',
                    { mode: 'warehouse', warehouse_id: null },
                ],
                [
                    'not_delivered with a warehouse_id',
                    { mode: 'not_delivered', warehouse_id: WAREHOUSE },
                ],
                [
                    'unmapped with a warehouse_id',
                    { mode: 'unmapped', warehouse_id: WAREHOUSE },
                ],
                ['a warehouse_id with no mode', { warehouse_id: WAREHOUSE }],
            ])('rejects %s with 400', async (_label, fields) => {
                await expect(
                    service.upsert(
                        ORG,
                        USER,
                        dto([
                            {
                                external_location_id: 'a',
                                ...(fields as {
                                    mode?: LocationMappingMode;
                                    warehouse_id?: string | null;
                                }),
                            },
                        ]),
                    ),
                ).rejects.toBeInstanceOf(BadRequestException);
                expect(dataSource.query).not.toHaveBeenCalled();
                expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
            });
        });

        it('rejects a location sent twice with 400', async () => {
            await expect(
                service.upsert(
                    ORG,
                    USER,
                    dto([
                        { external_location_id: 'a' },
                        { external_location_id: 'a', mode: 'not_delivered' },
                    ]),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
        });

        it('rejects a blank shop_domain with 400', async () => {
            await expect(
                service.upsert(
                    ORG,
                    USER,
                    dto([{ external_location_id: 'a' }], {
                        shop_domain: '   ',
                    }),
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });
});

describe('the modes, against the migration that created the table', () => {
    const sql = readFileSync(
        join(
            __dirname,
            '../database/migrations/1789866000000-create_integration_location_mapping.sql',
        ),
        'utf8',
    );

    it('allow exactly the modes the type does', () => {
        // A Record over the union, so adding a mode to the type without adding
        // it here is a compile error rather than a passing test.
        const modes: Record<LocationMappingMode, true> = {
            warehouse: true,
            not_delivered: true,
            unmapped: true,
        };
        const check = /"mode" IN \(([^)]*)\)/.exec(sql)?.[1];

        expect(
            check?.split(',').map((value) => value.trim().replace(/'/g, '')),
        ).toEqual(Object.keys(modes));
        expect([...LOCATION_MAPPING_MODES]).toEqual(Object.keys(modes));
    });

    it("default a new row to `unmapped`, the mode the service's insert falls back to", () => {
        expect(sql).toMatch(/"mode"\s+text\s+NOT NULL DEFAULT 'unmapped'/);
    });

    it('tie warehouse_id to mode `warehouse` both ways', () => {
        expect(sql).toContain(
            `CHECK (("mode" = 'warehouse') = ("warehouse_id" IS NOT NULL))`,
        );
    });

    it("pin the warehouse to the mapping's own organisation and unmap on delete", () => {
        expect(sql).toMatch(
            /FOREIGN KEY \("organisation_id", "warehouse_id"\)\s+REFERENCES "public"\."warehouse" \("organisation_id", "id"\)\s+ON DELETE SET NULL \("warehouse_id"\)/,
        );
    });
});
