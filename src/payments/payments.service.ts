import { randomBytes, randomUUID } from 'crypto';
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { ServiceFeesService } from 'src/service-fees/service-fees.service';
import { AddressDto } from 'src/service-fees/dto/calculate-service-fee.dto';
import { toE164OrNull } from 'src/common/phone';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { CustomersService } from 'src/customers/customers.service';
import { PayServiceFeeDto } from './dto/pay-service-fee.dto';
import { Payment } from './entities/payment.entity';

export interface CheckoutResult {
    checkoutUrl: string;
    sessionId: string;
}

/**
 * The only fields of a Checkout Session our fulfillment touches. Declared
 * explicitly rather than using `Stripe.Checkout.Session` (see StripeClient
 * for why) — and it keeps fulfillment decoupled from the SDK's wide union type.
 */
export interface FulfillableCheckoutSession {
    id: string;
    payment_status?: string | null;
    payment_intent?: string | { id: string } | null;
}

@Injectable()
export class PaymentsService {
    private readonly logger = new Logger(PaymentsService.name);
    private pendingStatusId: string | null = null;

    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @InjectRepository(Payment) private readonly paymentRepo: Repository<Payment>,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly serviceFeesService: ServiceFeesService,
        private readonly customersService: CustomersService,
    ) {}

    /**
     * Recompute the price server-side (never trust the client), create a
     * Stripe-hosted Checkout Session, and persist a `pending` payment carrying
     * the full booking so the webhook can fulfil it after payment.
     */
    async createCheckoutSession(dto: PayServiceFeeDto): Promise<CheckoutResult> {
        // calculate() also validates the service rate exists (404) BEFORE we
        // ever create a Stripe session or take money.
        const fee = await this.serviceFeesService.calculate(dto);

        // Normalise + validate phones up front: the customer table enforces
        // E.164, and a bad number must fail here (no charge) rather than during
        // post-payment fulfillment (charged, stranded).
        const booking = this.normalizeBookingPhones(dto);

        // Resolve the org so fulfillment can scope Stripe customers to the
        // right connected account. Nullable: booking flow is public (no auth).
        const rateOrg = await this.resolveServiceRateOrg(dto.serviceRateId);

        const paymentId = randomUUID();
        const successUrl =
            process.env.FRONTEND_SUCCESS_URL ??
            'http://localhost:3000/booking/success';
        const cancelUrl =
            process.env.FRONTEND_CANCEL_URL ??
            'http://localhost:3000/booking/cancel';

        const session = await this.stripe.checkout.sessions.create(
            {
                mode: 'payment',
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency: fee.currency.toLowerCase(),
                            unit_amount: fee.amount_minor,
                            product_data: {
                                name: `Delivery — ${fee.service_rate.name}`,
                            },
                        },
                    },
                ],
                success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: cancelUrl,
                client_reference_id: paymentId,
                customer_email: booking.sender.email,
                metadata: { payment_id: paymentId },
            },
            { idempotencyKey: paymentId },
        );

        if (!session.url) {
            throw new Error('Stripe did not return a Checkout URL');
        }

        await this.paymentRepo.insert({
            id: paymentId,
            organisationId: rateOrg,
            packageId: null,
            amountMinor: fee.amount_minor,
            currency: fee.currency,
            status: 'pending',
            stripeCheckoutSessionId: session.id,
            bookingDetails: booking,
        });

        return { checkoutUrl: session.url, sessionId: session.id };
    }

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
            booking_details: PayServiceFeeDto;
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
                address: this.toBookingAddress(booking.sender.address),
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
                        address: this.toBookingAddress(r.address),
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

    private toBookingAddress(address: AddressDto): {
        lon: number; lat: number; street: string; suburb: string; state: string; country: string;
    } {
        return {
            lon: address.lon,
            lat: address.lat,
            street: address.street,
            suburb: address.suburb,
            state: address.state,
            country: address.country,
        };
    }

    private async resolveServiceRateOrg(serviceRateId: string): Promise<string | null> {
        const rows: { organisation_id: string }[] = await this.dataSource.query(
            `SELECT organisation_id FROM service_rates WHERE id = $1`,
            [serviceRateId],
        );
        return rows[0]?.organisation_id ?? null;
    }

    private normalizeBookingPhones(dto: PayServiceFeeDto): PayServiceFeeDto {
        const senderPhone = toE164OrNull(dto.sender.phoneNumber);
        if (!senderPhone) {
            throw new BadRequestException('sender.phoneNumber must be a valid E.164 phone number');
        }
        const receiver = dto.receiver.map((r, i) => {
            const phone = toE164OrNull(r.phoneNumber);
            if (!phone) {
                throw new BadRequestException(`receiver[${i}].phoneNumber must be a valid E.164 phone number`);
            }
            return { ...r, phoneNumber: phone };
        });
        return { ...dto, sender: { ...dto.sender, phoneNumber: senderPhone }, receiver };
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
