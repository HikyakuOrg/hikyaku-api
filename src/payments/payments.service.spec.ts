import { NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

const BOOKING = {
    sender: {
        name: 'Ada',
        phoneNumber: '+61400000000',
        email: 'ada@example.com',
        address: {
            lon: 151.2,
            lat: -33.8,
            street: '1 Test St',
            suburb: 'Sydney',
            state: 'NSW',
            country: 'AU',
        },
        parcel: { weight: 2.5, height: 15, width: 20, length: 30 },
        collectionDate: '2026-09-01',
    },
    receiver: [
        {
            name: 'Grace',
            phoneNumber: '+61400000001',
            email: 'grace@example.com',
            address: {
                lon: 151.3,
                lat: -33.9,
                street: '2 Test St',
                suburb: 'Sydney',
                state: 'NSW',
                country: 'AU',
            },
            deliveryDate: '2026-09-03',
        },
    ],
    deliveryNotes: 'leave at door',
};

const PAYMENT = {
    id: 'pay-1',
    status: 'pending',
    booking_details: BOOKING,
    organisation_id: 'org-1',
};

interface State {
    payment?: Record<string, unknown> | null;
    lockedStatus?: string;
    warehouses?: { id: string }[];
}

function build(state: State = {}) {
    const log: { sql: string; params: unknown[] }[] = [];

    const answer = (sql: string): unknown[] => {
        if (sql.includes('FROM stripe.payments') && sql.includes('FOR UPDATE')) {
            return [{ id: 'pay-1', status: state.lockedStatus ?? 'pending' }];
        }
        if (sql.includes('FROM stripe.payments')) {
            if (state.payment === null) return [];
            return [state.payment ?? PAYMENT];
        }
        if (sql.includes('FROM warehouse w')) {
            return state.warehouses ?? [{ id: 'wh-nearest' }];
        }
        return [];
    };

    const query = jest.fn((sql: string, params: unknown[] = []) => {
        log.push({ sql, params });
        return Promise.resolve(answer(sql));
    });

    const runner = {
        query,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = { query, createQueryRunner: jest.fn(() => runner) };

    const customers = {
        resolveStripeAccount: jest.fn().mockResolvedValue('acct_1'),
        upsertFromBooking: jest
            .fn()
            .mockImplementation((_party, _acct, _org, key: string) =>
                Promise.resolve(key.endsWith(':sender') ? 'cust-from' : 'cust-to'),
            ),
    };
    const packages = {
        createMany: jest.fn().mockResolvedValue(['pkg-1']),
        assignCreated: jest.fn().mockResolvedValue(undefined),
    };

    const service = new PaymentsService(
        dataSource as never,
        customers as never,
        packages as never,
    );
    return { service, packages, customers, runner, log };
}

const session = { id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_1' };

describe('PaymentsService.fulfillCheckoutSession', () => {
    it('throws when the webhook beats our own payment row, so Stripe retries', async () => {
        const { service } = build({ payment: null });
        await expect(service.fulfillCheckoutSession(session)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('is a no-op for a payment already fulfilled', async () => {
        const { service, packages } = build({
            payment: { ...PAYMENT, status: 'completed' },
        });
        await service.fulfillCheckoutSession(session);
        expect(packages.createMany).not.toHaveBeenCalled();
    });

    it('is a no-op when a concurrent retry won the row lock', async () => {
        const { service, packages, runner } = build({ lockedStatus: 'completed' });
        await service.fulfillCheckoutSession(session);
        expect(packages.createMany).not.toHaveBeenCalled();
        expect(runner.commitTransaction).toHaveBeenCalled();
    });

    it('creates the packages on the payment’s own transaction', async () => {
        // They have to commit together, or a paid booking has no parcel.
        const { service, packages, runner } = build();
        await service.fulfillCheckoutSession(session);

        expect(packages.createMany).toHaveBeenCalledWith(
            runner,
            'org-1',
            expect.any(Array),
        );
    });

    it('supplies the organisation the old INSERT omitted', async () => {
        // packages.organisation_id is NOT NULL and the previous insert left it
        // out, so this path could only ever have been failing.
        const { service, packages } = build();
        await service.fulfillCheckoutSession(session);
        expect(packages.createMany.mock.calls[0][1]).toBe('org-1');
    });

    it('refuses a booking with no organisation rather than writing an orphan', async () => {
        const { service, runner } = build({
            payment: { ...PAYMENT, organisation_id: null },
        });
        await expect(service.fulfillCheckoutSession(session)).rejects.toThrow(
            /no organisation/,
        );
        expect(runner.rollbackTransaction).toHaveBeenCalled();
    });

    it('resolves the depot nearest the sender', async () => {
        const { service, packages, log } = build();
        await service.fulfillCheckoutSession(session);

        const lookup = log.find((q) => q.sql.includes('FROM warehouse w'));
        expect(lookup?.sql).toContain('<->');
        expect(lookup?.params).toEqual(['org-1', 'cust-from']);
        expect(packages.createMany.mock.calls[0][2][0].warehouseId).toBe('wh-nearest');
    });

    it('refuses when the organisation has no warehouse at all', async () => {
        // A package with no warehouse is invisible to every candidate query and
        // would sit unrouted forever.
        const { service } = build({ warehouses: [] });
        await expect(service.fulfillCheckoutSession(session)).rejects.toThrow(
            /no warehouse/,
        );
    });

    it('promises end of the delivery day, not the top of it', async () => {
        // T00:00:00Z made every booking instantly past-due the moment it was
        // created, which pinned them all at priority 100.
        const { service, packages } = build();
        await service.fulfillCheckoutSession(session);

        const spec = packages.createMany.mock.calls[0][2][0];
        expect(spec.deadlineAt).toBe('2026-09-03T23:59:59.999Z');
        expect(spec.scheduledDeparture).toBe('2026-09-01T00:00:00Z');
    });

    it('carries the parcel dimensions and notes through', async () => {
        const { service, packages } = build();
        await service.fulfillCheckoutSession(session);

        expect(packages.createMany.mock.calls[0][2][0]).toMatchObject({
            fromCustomerId: 'cust-from',
            toCustomerId: 'cust-to',
            weightKg: 2.5,
            lengthCm: 30,
            widthCm: 20,
            heightCm: 15,
            deliveryNotes: 'leave at door',
        });
    });

    it('records the first package against the payment', async () => {
        const { service, log } = build();
        await service.fulfillCheckoutSession(session);

        const update = log.find((q) => q.sql.includes('UPDATE stripe.payments'));
        expect(update?.params).toEqual(['pkg-1', 'pi_1', 'pay-1']);
    });

    it('assigns only after the payment has committed', async () => {
        const order: string[] = [];
        const { service, packages, runner } = build();
        runner.commitTransaction.mockImplementation(() => {
            order.push('commit');
            return Promise.resolve();
        });
        packages.assignCreated.mockImplementation(() => {
            order.push('assign');
            return Promise.resolve();
        });

        await service.fulfillCheckoutSession(session);
        expect(order).toEqual(['commit', 'assign']);
    });

    it('does not fail a paid booking because no van had room', async () => {
        const { service, packages } = build();
        packages.assignCreated.mockRejectedValue(new Error('every van is full'));
        await expect(service.fulfillCheckoutSession(session)).resolves.toBeUndefined();
    });

    it('rolls back everything when package creation throws', async () => {
        const { service, packages, runner } = build();
        packages.createMany.mockRejectedValue(new Error('constraint violation'));

        await expect(service.fulfillCheckoutSession(session)).rejects.toThrow();
        expect(runner.rollbackTransaction).toHaveBeenCalled();
        expect(runner.commitTransaction).not.toHaveBeenCalled();
    });

    it('accepts a payment intent given as an object', async () => {
        const { service, log } = build();
        await service.fulfillCheckoutSession({
            id: 'cs_test_1',
            payment_intent: { id: 'pi_obj' },
        });
        const update = log.find((q) => q.sql.includes('UPDATE stripe.payments'));
        expect(update?.params[1]).toBe('pi_obj');
    });
});
