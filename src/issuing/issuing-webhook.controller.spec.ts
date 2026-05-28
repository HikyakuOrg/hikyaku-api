import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import { OrganisationsService } from 'src/organisations/organisations.service';
import { ConnectService } from 'src/connect/connect.service';
import { IssuingWebhookController } from './issuing-webhook.controller';

describe('IssuingWebhookController', () => {
    let controller: IssuingWebhookController;
    let stripe: { webhooks: { constructEvent: jest.Mock } };
    let orgs: { updateConnectStatus: jest.Mock };
    let connect: { maybeRequestCardIssuing: jest.Mock };

    const rawReq = { rawBody: Buffer.from('{}') };

    beforeEach(async () => {
        process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_test';
        stripe = { webhooks: { constructEvent: jest.fn() } };
        orgs = { updateConnectStatus: jest.fn().mockResolvedValue(undefined) };
        connect = {
            maybeRequestCardIssuing: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [IssuingWebhookController],
            providers: [
                { provide: STRIPE_CLIENT, useValue: stripe },
                { provide: OrganisationsService, useValue: orgs },
                { provide: ConnectService, useValue: connect },
            ],
        }).compile();

        controller = module.get<IssuingWebhookController>(IssuingWebhookController);
    });

    it('syncs the connected account state and requests card_issuing on account.updated', async () => {
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'account.updated',
            account: 'acct_1',
            data: {
                object: {
                    id: 'acct_1',
                    details_submitted: true,
                    charges_enabled: true,
                    payouts_enabled: false,
                    capabilities: { card_issuing: 'active' },
                },
            },
        });

        const res = await controller.handle(rawReq, 'sig');

        expect(orgs.updateConnectStatus).toHaveBeenCalledWith('acct_1', {
            detailsSubmitted: true,
            chargesEnabled: true,
            payoutsEnabled: false,
            cardIssuingStatus: 'active',
        });
        expect(connect.maybeRequestCardIssuing).toHaveBeenCalledWith('acct_1');
        expect(res).toEqual({ received: true });
    });

    it('no-ops (200) on issuing_transaction.created — cards/transactions are now read on demand from Stripe', async () => {
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'issuing_transaction.created',
            data: { object: { id: 'ipi_1', amount: -100, currency: 'usd', card: 'ic_1' } },
        });

        const res = await controller.handle(rawReq, 'sig');

        expect(orgs.updateConnectStatus).not.toHaveBeenCalled();
        expect(res).toEqual({ received: true });
    });

    it('no-ops (200) on issuing_card.updated — card status is now read on demand from Stripe', async () => {
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'issuing_card.updated',
            data: { object: { id: 'ic_1', status: 'inactive' } },
        });

        const res = await controller.handle(rawReq, 'sig');

        expect(orgs.updateConnectStatus).not.toHaveBeenCalled();
        expect(res).toEqual({ received: true });
    });

    it('ignores unrelated event types', async () => {
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'issuing_authorization.created',
            data: { object: { id: 'iauth_1' } },
        });

        const res = await controller.handle(rawReq, 'sig');

        expect(orgs.updateConnectStatus).not.toHaveBeenCalled();
        expect(res).toEqual({ received: true });
    });

    it('throws BadRequestException when signature verification fails', async () => {
        stripe.webhooks.constructEvent.mockImplementation(() => {
            throw new Error('bad signature');
        });

        await expect(controller.handle(rawReq, 'sig')).rejects.toThrow(
            BadRequestException,
        );
    });

    it('throws BadRequestException when the raw body is missing', async () => {
        await expect(controller.handle({}, 'sig')).rejects.toThrow(
            BadRequestException,
        );
    });
});
