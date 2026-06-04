import { randomBytes } from 'crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { CustomersService } from 'src/customers/customers.service';

/**
 * The only fields of a Checkout Session our fulfillment touches. Declared
 * explicitly (not `Stripe.Checkout.Session`) so it is decoupled from the SDK's
 * wide union type — and so a connected-account event (which carries the same
 * session shape) fulfils identically.
 */
export interface FulfillableCheckoutSession {
    id: string;
    payment_status?: string | null;
    payment_intent?: string | { id: string } | null;
}

/** Shape of the booking persisted at /pay time (services/booking.service). */
interface BookingAddress {
    lon: number;
    lat: number;
    street: string;
    suburb: string;
    state: string;
    country: string;
}
interface BookingParty {
    name: string;
    phoneNumber: string;
    email: string;
    address: BookingAddress;
}
interface BookingDetails {
    sender: BookingParty & {
        parcel: { weight: number; height: number; width: number; length: number };
        collectionDate: string;
    };
    receiver: (BookingParty & { deliveryDate: string })[];
    deliveryNotes?: string | null;
}

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);
    private pendingStatusId: string | null = null;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly customersService: CustomersService,
    ) {}

    /**
     * Idempotently turn a paid Checkout Session into a customer + package.
     *
     * Stripe customers are created first (outside any DB transaction) so we
     * never hold an open connection across a network call. The package
     * insertion runs in a separate short transaction, re-locking the payment
     * row to guard against concurrent webhook retries.
     */
    async fulfillCheckoutSession(session: FulfillableCheckoutSession): Promise<void> {
        // ── Step 1: Read payment (no lock — optimistic check) ─────────────────
        const paymentRows: {
            id: string;
            status: string;
            booking_details: BookingDetails;
            organisation_id: string | null;
        }[] = await this.dataSource.query(
            `SELECT id, status, booking_details, organisation_id
             FROM stripe.payments
             WHERE stripe_checkout_session_id = $1`,
            [session.id],
        );

        if (paymentRows.length === 0) {
            // Webhook arrived before our own DB insert — Stripe will retry.
            throw new NotFoundException(`No payment for checkout session ${session.id}`);
        }

        const payment = paymentRows[0];
        if (payment.status === 'completed') {
            this.logger.log(`Payment ${payment.id} already fulfilled — no-op`);
            return;
        }

        const booking = payment.booking_details;

        // ── Step 2: Create Stripe customers + thin DB rows (outside any tx) ───
        const stripeAccountId = payment.organisation_id
            ? await this.customersService.resolveStripeAccount(payment.organisation_id)
            : null;

        const fromCustomerId = await this.customersService.upsertFromBooking(
            {
                name: booking.sender.name,
                phone: booking.sender.phoneNumber,
                email: booking.sender.email,
                address: booking.sender.address,
            },
            stripeAccountId,
            payment.organisation_id,
            `${session.id}:sender`,
        );

        const receiverCustomerIds = await Promise.all(
            booking.receiver.map((r, i) =>
                this.customersService.upsertFromBooking(
                    {
                        name: r.name,
                        phone: r.phoneNumber,
                        email: r.email,
                        address: r.address,
                    },
                    stripeAccountId,
                    payment.organisation_id,
                    `${session.id}:receiver:${i}`,
                ),
            ),
        );

        // ── Step 3: Insert packages + mark payment completed (transactional) ──
        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();

        try {
            // Re-lock and re-check — guards against concurrent retries that both
            // passed the optimistic check above.
            const lockRows: { id: string; status: string }[] = await runner.query(
                `SELECT id, status FROM stripe.payments
                 WHERE stripe_checkout_session_id = $1 FOR UPDATE`,
                [session.id],
            );

            if (lockRows[0]?.status === 'completed') {
                await runner.commitTransaction();
                this.logger.log(`Payment ${payment.id} already fulfilled — no-op (retry)`);
                return;
            }

            const pendingStatusId = await this.getPendingStatusId(runner);
            let firstPackageId: string | null = null;

            for (let i = 0; i < booking.receiver.length; i++) {
                const receiver = booking.receiver[i];
                const toCustomerId = receiverCustomerIds[i];

                const packageRows: { id: string }[] = await runner.query(
                    `INSERT INTO packages (from_customer, to_customer, tracking_number, delivery_notes)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [fromCustomerId, toCustomerId, this.generateTrackingNumber(), booking.deliveryNotes ?? null],
                );
                const packageId = packageRows[0].id;
                firstPackageId ??= packageId;

                await runner.query(
                    `INSERT INTO package_dimensions (package_id, weight_kg, length_cm, width_cm, height_cm)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [packageId, booking.sender.parcel.weight, booking.sender.parcel.length, booking.sender.parcel.width, booking.sender.parcel.height],
                );

                await runner.query(
                    `INSERT INTO package_delivery_window (package_id, scheduled_departure, scheduled_arrival)
                     VALUES ($1, $2::timestamptz, $3::timestamptz)`,
                    [packageId, `${booking.sender.collectionDate}T00:00:00Z`, `${receiver.deliveryDate}T00:00:00Z`],
                );

                await runner.query(
                    `INSERT INTO package_timeline (package_id, package_status) VALUES ($1, $2)`,
                    [packageId, pendingStatusId],
                );
            }

            const paymentIntentId =
                typeof session.payment_intent === 'string'
                    ? session.payment_intent
                    : (session.payment_intent?.id ?? null);

            await runner.query(
                `UPDATE stripe.payments
                 SET status = 'completed', package_id = $1,
                     stripe_payment_intent_id = $2, updated_at = now()
                 WHERE id = $3`,
                [firstPackageId, paymentIntentId, payment.id],
            );

            await runner.commitTransaction();
            this.logger.log(`Fulfilled payment ${payment.id} (session ${session.id})`);
        } catch (err) {
            await runner.rollbackTransaction();
            this.logger.error(`Fulfillment failed for session ${session.id}: ${String(err)}`);
            throw err;
        } finally {
            await runner.release();
        }
    }

    private async getPendingStatusId(runner: QueryRunner): Promise<string> {
        if (this.pendingStatusId) return this.pendingStatusId;
        const rows: { id: string }[] = await runner.query(
            `SELECT id FROM package_status WHERE enums = 'PENDING' LIMIT 1`,
        );
        if (rows.length === 0) throw new Error("package_status row with enums = 'PENDING' not found");
        this.pendingStatusId = String(rows[0].id);
        return this.pendingStatusId;
    }

    private generateTrackingNumber(): string {
        return `WDN${randomBytes(6).toString('hex').toUpperCase()}`;
    }
}
