import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import { IssuingWebhookController } from './issuing-webhook.controller';
import { IssuingService } from './issuing.service';

describe('IssuingWebhookController', () => {
    let controller: IssuingWebhookController;
    let stripe: { webhooks: { constructEvent: jest.Mock } };
    let issuing: { recordTransaction: jest.Mock; syncCardStatus: jest.Mock };

    const rawReq = { rawBody: Buffer.from('{}') };

    beforeEach(async () => {
        process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test';
        stripe = { webhooks: { constructEvent: jest.fn() } };
        issuing = {
            recordTransaction: jest.fn().mockResolvedValue(undefined),
            syncCardStatus: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [IssuingWebhookController],
            providers: [
                { provide: STRIPE_CLIENT, useValue: stripe },
                { provide: IssuingService, useValue: issuing },
            ],
        }).compile();

        controller = module.get<IssuingWebhookController>(IssuingWebhookController);
    });

    it('records the ledger entry on issuing_transaction.created', async () => {
        const txn = { id: 'ipi_1', amount: -100, currency: 'usd', card: 'ic_1' };
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'issuing_transaction.created',
            data: { object: txn },
        });

        const res = await controller.handle(rawReq, 'sig');

        expect(issuing.recordTransaction).toHaveBeenCalledWith(txn);
        expect(res).toEqual({ received: true });
    });

    it('syncs card status on issuing_card.updated', async () => {
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'issuing_card.updated',
            data: { object: { id: 'ic_1', status: 'inactive' } },
        });

        await controller.handle(rawReq, 'sig');

        expect(issuing.syncCardStatus).toHaveBeenCalledWith('ic_1', 'inactive');
    });

    it('ignores unrelated event types', async () => {
        stripe.webhooks.constructEvent.mockReturnValue({
            type: 'issuing_authorization.created',
            data: { object: { id: 'iauth_1' } },
        });

        const res = await controller.handle(rawReq, 'sig');

        expect(issuing.recordTransaction).not.toHaveBeenCalled();
        expect(issuing.syncCardStatus).not.toHaveBeenCalled();
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
