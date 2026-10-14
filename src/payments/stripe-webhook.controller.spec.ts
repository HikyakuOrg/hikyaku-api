import type { DataSource } from 'typeorm';
import type { BillingService } from 'src/billing/billing.service';
import { STATIC_RATES_CHANNEL } from 'src/integrations/static-rates/notify';
import type { OrganisationsService } from 'src/organisations/organisations.service';
import type { StripeClient } from 'src/stripe/stripe.provider';
import type { PaymentsService } from './payments.service';
import { StripeWebhookController } from './stripe-webhook.controller';

const ORG = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

/** The catalog half of the webhook: waking the static checkout rate push. */
describe('StripeWebhookController catalog events', () => {
    let controller: StripeWebhookController;
    let constructEvent: jest.Mock;
    let findByStripeAccountId: jest.Mock;
    let query: jest.Mock;

    async function deliver(event: Record<string, unknown>) {
        constructEvent.mockReturnValue({ data: { object: {} }, ...event });
        return controller.handle({ rawBody: Buffer.from('{}') }, 'sig');
    }

    beforeEach(() => {
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
        constructEvent = jest.fn();
        findByStripeAccountId = jest
            .fn()
            .mockResolvedValue({ organisationId: ORG });
        query = jest.fn().mockResolvedValue([]);
        controller = new StripeWebhookController(
            { webhooks: { constructEvent } } as unknown as StripeClient,
            {} as PaymentsService,
            {} as BillingService,
            { findByStripeAccountId } as unknown as OrganisationsService,
            { query } as unknown as DataSource,
        );
    });

    afterEach(() => {
        delete process.env.STRIPE_WEBHOOK_SECRET;
    });

    it.each(['product.updated', 'price.created', 'price.deleted'])(
        "notifies on a connected account's %s",
        async (type) => {
            await expect(deliver({ type, account: 'acct_1' })).resolves.toEqual(
                { received: true },
            );
            expect(findByStripeAccountId).toHaveBeenCalledWith('acct_1');
            expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
                STATIC_RATES_CHANNEL,
                `${ORG}|catalog`,
            ]);
        },
    );

    it("ignores the platform's own catalog", async () => {
        await deliver({ type: 'product.updated' });
        expect(query).not.toHaveBeenCalled();
    });

    it('ignores an account no organisation has', async () => {
        findByStripeAccountId.mockResolvedValue(null);
        await deliver({ type: 'price.updated', account: 'acct_unknown' });
        expect(query).not.toHaveBeenCalled();
    });

    it('ignores other connected-account events', async () => {
        await deliver({ type: 'account.updated', account: 'acct_1' });
        expect(findByStripeAccountId).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });
});
