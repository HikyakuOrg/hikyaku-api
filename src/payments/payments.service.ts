import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { CustomersService } from 'src/customers/customers.service';
import {
    PackagesService,
    type PackageSpec,
} from 'src/packages/packages.service';

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
        parcel: {
            weight: number;
            height: number;
            width: number;
            length: number;
        };
        collectionDate: string;
    };
    receiver: (BookingParty & { deliveryDate: string })[];
    deliveryNotes?: string | null;
}

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly customersService: CustomersService,
        private readonly packages: PackagesService,
    ) {}

    /**
     * Idempotently turn a paid Checkout Session into a customer + package.
     *
     * Stripe customers are created first (outside any DB transaction) so we
     * never hold an open connection across a network call. The package
     * insertion runs in a separate short transaction, re-locking the payment
     * row to guard against concurrent webhook retries.
     */
    async fulfillCheckoutSession(
        session: FulfillableCheckoutSession,
    ): Promise<void> {
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
            throw new NotFoundException(
                `No payment for checkout session ${session.id}`,
            );
        }

        const payment = paymentRows[0];
        if (payment.status === 'completed') {
            this.logger.log(`Payment ${payment.id} already fulfilled — no-op`);
            return;
        }

        const booking = payment.booking_details;

        // ── Step 2: Create Stripe customers + thin DB rows (outside any tx) ───
        const stripeAccountId = payment.organisation_id
            ? await this.customersService.resolveStripeAccount(
                  payment.organisation_id,
              )
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
        let createdPackageIds: string[] = [];

        try {
            // Re-lock and re-check — guards against concurrent retries that both
            // passed the optimistic check above.
            const lockRows: { id: string; status: string }[] =
                await runner.query(
                    `SELECT id, status FROM stripe.payments
                 WHERE stripe_checkout_session_id = $1 FOR UPDATE`,
                    [session.id],
                );

            if (lockRows[0]?.status === 'completed') {
                await runner.commitTransaction();
                this.logger.log(
                    `Payment ${payment.id} already fulfilled — no-op (retry)`,
                );
                return;
            }

            // organisation_id is NOT NULL on packages, and the INSERT this
            // replaces omitted it entirely -- which means this path could only
            // ever have been failing. A booking with no organisation cannot
            // produce a package, and saying so is better than writing a row that
            // no dispatcher can see.
            if (!payment.organisation_id) {
                throw new Error(
                    `Payment ${payment.id} has no organisation; cannot create packages for it.`,
                );
            }

            const warehouseId = await this.resolveWarehouse(
                runner,
                payment.organisation_id,
                fromCustomerId,
            );

            const specs: PackageSpec[] = booking.receiver.map(
                (receiver, i) => ({
                    warehouseId,
                    fromCustomerId,
                    toCustomerId: receiverCustomerIds[i],
                    deliveryNotes: booking.deliveryNotes ?? null,
                    weightKg: booking.sender.parcel.weight,
                    lengthCm: booking.sender.parcel.length,
                    widthCm: booking.sender.parcel.width,
                    heightCm: booking.sender.parcel.height,
                    scheduledDeparture: `${booking.sender.collectionDate}T00:00:00Z`,
                    // END of the promised day, not the start. Midnight at the top of
                    // the delivery date makes every booking instantly past-due, which
                    // is how these packages ended up permanently at priority 100.
                    deadlineAt: `${receiver.deliveryDate}T23:59:59.999Z`,
                }),
            );

            // One call, on this transaction: the packages and the completed
            // payment commit together, or a paid booking has no parcel.
            const packageIds = await this.packages.createMany(
                runner,
                payment.organisation_id,
                specs,
            );
            createdPackageIds = packageIds;
            const firstPackageId = packageIds[0] ?? null;

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
            this.logger.log(
                `Fulfilled payment ${payment.id} (session ${session.id})`,
            );
        } catch (err) {
            await runner.rollbackTransaction();
            this.logger.error(
                `Fulfillment failed for session ${session.id}: ${String(err)}`,
            );
            throw err;
        } finally {
            await runner.release();
        }

        // ── Step 4: Assign, AFTER the payment is safely committed ────────────
        // Deliberately outside the transaction and deliberately not fatal. The
        // customer has paid; a van that cannot take the parcel today is a
        // dispatch problem, not a payment failure, and the package stays PENDING
        // for the replan worker either way.
        if (payment.organisation_id && createdPackageIds.length > 0) {
            try {
                await this.packages.assignCreated(
                    payment.organisation_id,
                    createdPackageIds,
                );
            } catch (err: unknown) {
                this.logger.warn(
                    `Assignment after payment ${payment.id} failed; packages remain pending: ${String(err)}`,
                );
            }
        }
    }

    /**
     * The depot nearest the sender.
     *
     * Bookings arrive from the public site with no warehouse at all -- the
     * customer has no idea our depots exist -- so it has to be inferred, and the
     * only signal available is where the parcel is being collected from. `<->` is
     * the PostGIS distance operator, which uses the geometry index rather than
     * measuring every warehouse.
     *
     * Throws when the organisation has none: a package with no warehouse is
     * invisible to every candidate query and would sit unrouted forever, which is
     * a worse outcome than a loud webhook failure Stripe will retry.
     */
    private async resolveWarehouse(
        runner: QueryRunner,
        organisationId: string,
        senderCustomerId: string,
    ): Promise<string> {
        const rows: { id: string }[] = await runner.query(
            `SELECT w.id
               FROM warehouse w
               LEFT JOIN customer c ON c.id = $2
              WHERE w.organisation_id = $1
              ORDER BY CASE
                         WHEN c.customer_location IS NULL THEN 1
                         ELSE 0
                       END,
                       w.warehouse_location <-> c.customer_location
              LIMIT 1`,
            [organisationId, senderCustomerId],
        );

        if (rows.length === 0) {
            throw new Error(
                `Organisation ${organisationId} has no warehouse; a booked package would be unroutable.`,
            );
        }
        return rows[0].id;
    }
}
