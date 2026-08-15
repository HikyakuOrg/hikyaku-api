import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { OrganisationsService } from 'src/organisations/organisations.service';
import type { Organisation } from 'src/organisations/organisation.entity';

const DAY = 24 * 60 * 60 * 1000;

function org(trialEndsAt: Date | null): Organisation {
    return {
        id: 'org-1',
        slug: 'acme',
        name: 'Acme',
        orgType: trialEndsAt ? 'company' : 'personal',
        createdBy: 'u1',
        createdAt: new Date(),
        trialEndsAt,
    };
}

describe('BillingService', () => {
    let service: BillingService;
    let organisations: { getOrFail: jest.Mock };

    beforeEach(async () => {
        organisations = { getOrFail: jest.fn() };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BillingService,
                { provide: OrganisationsService, useValue: organisations },
            ],
        }).compile();
        service = module.get(BillingService);
    });

    it('reports a running trial with its deadline and day count', async () => {
        // Half a day off the boundary on purpose. An exact `now + 7 * DAY` sits
        // precisely on the floor boundary, so whether the service's own
        // `new Date()` lands in the same millisecond as the test's decides
        // between 6 and 7 — a real coin-flip failure, not a hypothetical one.
        const endsAt = new Date(Date.now() + 6 * DAY + 12 * 60 * 60 * 1000);
        organisations.getOrFail.mockResolvedValue(org(endsAt));

        const status = await service.getTrialStatus('org-1');

        expect(status.state).toBe('active');
        expect(status.trialEndsAt).toBe(endsAt.toISOString());
        expect(status.daysRemaining).toBe(6);
    });

    it('reports an elapsed trial as expired with 0 days left', async () => {
        organisations.getOrFail.mockResolvedValue(org(new Date(Date.now() - DAY)));

        const status = await service.getTrialStatus('org-1');

        expect(status.state).toBe('expired');
        expect(status.daysRemaining).toBe(0);
    });

    // A personal org has no deadline; the dashboard must read that as "nothing to
    // show" rather than rendering an expired banner.
    it('reports an org with no deadline as "none" with nulls', async () => {
        organisations.getOrFail.mockResolvedValue(org(null));

        expect(await service.getTrialStatus('org-1')).toEqual({
            state: 'none',
            trialEndsAt: null,
            daysRemaining: null,
        });
    });

    it('propagates the 404 for an organisation that does not exist', async () => {
        organisations.getOrFail.mockRejectedValue(
            new NotFoundException('Organisation not found'),
        );

        await expect(service.getTrialStatus('nope')).rejects.toThrow(
            NotFoundException,
        );
    });
});
