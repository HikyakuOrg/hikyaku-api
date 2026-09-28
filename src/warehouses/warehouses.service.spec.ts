import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { WarehousesService } from './warehouses.service';

describe('WarehousesService', () => {
    let service: WarehousesService;
    let dataSource: {
        query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
    };

    beforeEach(async () => {
        dataSource = {
            query: jest.fn<Promise<unknown[]>, [string, unknown[]?]>(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WarehousesService,
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();

        service = module.get<WarehousesService>(WarehousesService);
    });

    it('reads only the organisation’s warehouses and returns numeric coordinates', async () => {
        dataSource.query.mockResolvedValueOnce([
            {
                id: 'wh-1',
                name: 'West Melbourne Depot',
                address: '1 Dock Road',
                city: 'West Melbourne',
                state: 'VIC',
                postcode: '3003',
                country: 'Australia',
                timezone: 'Australia/Melbourne',
                // pg returns float8 as a number, but a numeric cast would
                // come back as a string; either way the DTO says number.
                lon: '144.9407',
                lat: -37.8063,
            },
        ]);

        const result = await service.list('org-1');

        const [sql, params] = dataSource.query.mock.calls[0];
        expect(sql).toContain('WHERE organisation_id = $1');
        expect(params).toEqual(['org-1']);
        expect(result).toEqual([
            expect.objectContaining({
                id: 'wh-1',
                lon: 144.9407,
                lat: -37.8063,
            }),
        ]);
    });
});
