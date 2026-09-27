import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Organisation } from './organisation.entity';
import { OrganisationStripeAccount } from './organisation-stripe-account.entity';
import { OrganisationSubscription } from './organisation-subscription.entity';
import { OrganisationsService } from './organisations.service';

describe('OrganisationsService', () => {
    let service: OrganisationsService;
    let dataSource: {
        query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
    };

    beforeEach(async () => {
        dataSource = {
            query: jest.fn<Promise<unknown[]>, [string, unknown[]?]>(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrganisationsService,
                { provide: getRepositoryToken(Organisation), useValue: {} },
                {
                    provide: getRepositoryToken(OrganisationStripeAccount),
                    useValue: {},
                },
                {
                    provide: getRepositoryToken(OrganisationSubscription),
                    useValue: {},
                },
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();

        service = module.get<OrganisationsService>(OrganisationsService);
    });

    describe('listForMember', () => {
        it('maps rows to camelCase and scopes the query to the user and permission', async () => {
            dataSource.query.mockResolvedValueOnce([
                {
                    id: 'org-1',
                    slug: 'acme-logistics',
                    name: 'Acme Logistics',
                    org_type: 'company',
                },
            ]);

            const result = await service.listForMember(
                'user-1',
                'integrations.orders.write',
            );

            expect(result).toEqual([
                {
                    id: 'org-1',
                    slug: 'acme-logistics',
                    name: 'Acme Logistics',
                    orgType: 'company',
                },
            ]);

            const [sql, params] = dataSource.query.mock.calls[0];
            expect(params).toEqual(['user-1', 'integrations.orders.write']);
            // Membership comes from team_members, the table PermissionGuard
            // checks, and the permission from an EXISTS so no org repeats.
            expect(sql).toContain(
                'ON tm.organisation_id = o.id AND tm.id = $1',
            );
            expect(sql).toContain('WHERE EXISTS');
            expect(sql).toContain('AND up.user_id = $1');
            expect(sql).toContain('AND ap.permission = $2');
        });

        it('returns an empty array when the user has no qualifying memberships', async () => {
            dataSource.query.mockResolvedValueOnce([]);

            await expect(
                service.listForMember('user-1', 'integrations.orders.write'),
            ).resolves.toEqual([]);
        });
    });
});
