import { randomUUID } from 'crypto';
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { STRIPE_CLIENT } from 'src/stripe/stripe.provider';
import type { StripeClient } from 'src/stripe/stripe.provider';
import { OrsService } from 'src/ors/ors.service';
import type { DirectionsResponse } from 'src/ors/ors.types';
import { fromStripeMinorUnits } from 'src/common/money';
import { toE164OrNull } from 'src/common/phone';
import { Payment } from 'src/payments/entities/payment.entity';
import { Service } from './entities/service.entity';
import { ServiceAddon } from './entities/service-addon.entity';
import { ServicesService } from './services.service';
import {
    isIntegerUnit,
    quantityForUnit,
    unitSuffix,
    type QuantityContext,
} from './pricing';
import { QuoteBookingDto } from './dto/quote-booking.dto';
import { PayBookingDto } from './dto/pay-booking.dto';

type SessionCreateParams = NonNullable<
    Parameters<StripeClient['checkout']['sessions']['create']>[0]
>;
type StripeLineItem = NonNullable<SessionCreateParams['line_items']>[number];

/** One priced line in a quote, returned to the booking review step. */
export interface QuoteLine {
    id: string;
    name: string;
    pricing_unit: string;
    /** Per-unit rate in major units (read from Stripe). */
    rate: number;
    quantity: number;
    amount_minor: number;
}

export interface QuoteResponse {
    currency: string;
    lines: QuoteLine[];
    total_minor: number;
    total: number;
}

export interface CheckoutResult {
    checkoutUrl: string;
    sessionId: string;
}

/** Internal: a fully resolved line, with the Stripe id + how to bill it. */
interface ComputedLine extends QuoteLine {
    currency: string;
    stripePriceId: string;
    isInteger: boolean;
    /** Descriptive name for the Stripe price_data line (fractional units). */
    lineLabel: string;
}

@Injectable()
export class BookingService {
    constructor(
        @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient,
        @InjectRepository(Service)
        private readonly serviceRepo: Repository<Service>,
        @InjectRepository(ServiceAddon)
        private readonly addonRepo: Repository<ServiceAddon>,
        @InjectRepository(Payment)
        private readonly paymentRepo: Repository<Payment>,
        private readonly services: ServicesService,
        private readonly ors: OrsService,
    ) {}

    /** Itemised, server-authoritative quote. No charge. */
    async quote(organisationId: string, dto: QuoteBookingDto): Promise<QuoteResponse> {
        const { service, addons } = await this.loadItems(
            organisationId,
            dto.serviceId,
            dto.addonIds ?? [],
        );
        const stripeAccount = await this.services.requireConnectedAccount(organisationId);
        const priceMap = await this.services.fetchActivePriceMap(stripeAccount);
        const lines = await this.computeLines(service, addons, priceMap, dto);

        const currency = lines[0]?.currency ?? 'usd';
        const totalMinor = lines.reduce((sum, l) => sum + l.amount_minor, 0);
        return {
            currency,
            lines: lines.map((l) => ({
                id: l.id,
                name: l.name,
                pricing_unit: l.pricing_unit,
                rate: l.rate,
                quantity: l.quantity,
                amount_minor: l.amount_minor,
            })),
            total_minor: totalMinor,
            total: fromStripeMinorUnits(totalMinor, currency),
        };
    }

    /**
     * Recompute lines authoritatively, create a Checkout Session on the org's
     * connected account (direct charge), and persist a `pending` payment carrying
     * the booking so the Stripe webhook can fulfil it after payment. No package or
     * customer is created here.
     */
    async pay(organisationId: string, dto: PayBookingDto): Promise<CheckoutResult> {
        const { service, addons } = await this.loadItems(
            organisationId,
            dto.serviceId,
            dto.addonIds ?? [],
        );
        const stripeAccount = await this.services.requireConnectedAccount(organisationId);
        const priceMap = await this.services.fetchActivePriceMap(stripeAccount);
        const lines = await this.computeLines(service, addons, priceMap, dto);

        // Normalise + validate phones BEFORE creating the session — a bad number
        // must fail here (no charge), not during post-payment fulfillment.
        const booking = this.normalizeBookingPhones(dto);

        const paymentId = randomUUID();
        const successUrl =
            process.env.FRONTEND_SUCCESS_URL ?? 'http://localhost:3000/booking/success';
        const cancelUrl =
            process.env.FRONTEND_CANCEL_URL ?? 'http://localhost:3000/booking/cancel';

        const lineItems: StripeLineItem[] = lines.map((line) =>
            line.isInteger
                ? { price: line.stripePriceId, quantity: line.quantity }
                : {
                      price_data: {
                          currency: line.currency,
                          unit_amount: line.amount_minor,
                          product_data: { name: line.lineLabel },
                      },
                      quantity: 1,
                  },
        );

        const session = await this.stripe.checkout.sessions.create(
            {
                mode: 'payment',
                line_items: lineItems,
                success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: cancelUrl,
                client_reference_id: paymentId,
                customer_email: booking.sender.email,
                metadata: { payment_id: paymentId, organisation_id: organisationId },
            },
            { stripeAccount, idempotencyKey: paymentId },
        );

        if (!session.url) {
            throw new Error('Stripe did not return a Checkout URL');
        }

        // Persist using the session's OWN totals — no replicated price math.
        await this.paymentRepo.insert({
            id: paymentId,
            organisationId,
            packageId: null,
            amountMinor: session.amount_total ?? 0,
            currency: session.currency ?? lines[0]?.currency ?? 'usd',
            status: 'pending',
            stripeCheckoutSessionId: session.id,
            bookingDetails: {
                sender: booking.sender,
                receiver: booking.receiver,
                deliveryNotes: booking.deliveryNotes ?? null,
            },
        });

        return { checkoutUrl: session.url, sessionId: session.id };
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private async loadItems(
        organisationId: string,
        serviceId: string,
        addonIds: string[],
    ): Promise<{ service: Service; addons: ServiceAddon[] }> {
        const service = await this.serviceRepo.findOne({
            where: { id: serviceId, organisationId },
        });
        if (!service) throw new NotFoundException('Service not found');

        if (addonIds.length === 0) return { service, addons: [] };

        const found = await this.addonRepo.find({
            where: { id: In(addonIds), serviceId: service.id },
        });
        if (found.length !== addonIds.length) {
            throw new BadRequestException('One or more add-ons are not valid for this service.');
        }
        // Preserve the order the client selected.
        const byId = new Map(found.map((a) => [a.id, a]));
        const addons = addonIds
            .map((id) => byId.get(id))
            .filter((a): a is ServiceAddon => a !== undefined);
        return { service, addons };
    }

    private async computeLines(
        service: Service,
        addons: ServiceAddon[],
        priceMap: Map<string, { name: string; amountMinor: number; currency: string }>,
        dto: QuoteBookingDto,
    ): Promise<ComputedLine[]> {
        const items: (Service | ServiceAddon)[] = [service, ...addons];
        const needsDistance = items.some(
            (i) => i.pricingUnit === 'per_km' || i.pricingUnit === 'per_mi',
        );

        const ctx: QuantityContext = {
            distanceKm: needsDistance ? await this.getRouteDistanceKm(dto) : 0,
            weightKg: dto.sender.parcel.weight,
            recipientCount: dto.receiver.length,
        };

        return items.map((item) => {
            const price = priceMap.get(item.stripePriceId);
            if (!price) {
                throw new BadRequestException(
                    'Pricing is unavailable for this service. Please try again.',
                );
            }
            const quantity = quantityForUnit(item.pricingUnit, ctx);
            const amountMinor = Math.round(price.amountMinor * quantity);
            const rate = fromStripeMinorUnits(price.amountMinor, price.currency);
            return {
                id: item.id,
                name: price.name,
                pricing_unit: item.pricingUnit,
                rate,
                quantity,
                amount_minor: amountMinor,
                currency: price.currency,
                stripePriceId: item.stripePriceId,
                isInteger: isIntegerUnit(item.pricingUnit),
                lineLabel: this.buildLineLabel(
                    price.name,
                    item.pricingUnit,
                    quantity,
                    rate,
                    price.currency,
                ),
            };
        });
    }

    private buildLineLabel(
        name: string,
        unit: string,
        quantity: number,
        rate: number,
        currency: string,
    ): string {
        if (isIntegerUnit(unit)) return name;
        const suffix = unitSuffix(unit);
        const code = currency.toUpperCase();
        return `${name} (${quantity.toFixed(2)} ${suffix} × ${rate.toFixed(2)} ${code}/${suffix})`;
    }

    private async getRouteDistanceKm(dto: QuoteBookingDto): Promise<number> {
        const coordinates = [
            [dto.sender.address.lon, dto.sender.address.lat],
            ...dto.receiver.map((r) => [r.address.lon, r.address.lat]),
        ];

        let result: DirectionsResponse;
        try {
            result = (await this.ors.proxyPost('/v2/directions/driving-car', {
                coordinates,
                units: 'km',
            })) as DirectionsResponse;
        } catch {
            throw new ServiceUnavailableException('Distance calculation unavailable');
        }
        if (!result?.routes?.length) {
            throw new ServiceUnavailableException('Distance calculation unavailable');
        }
        return result.routes[0].summary.distance;
    }

    private normalizeBookingPhones(dto: PayBookingDto): PayBookingDto {
        const senderPhone = toE164OrNull(dto.sender.phoneNumber);
        if (!senderPhone) {
            throw new BadRequestException(
                'sender.phoneNumber must be a valid E.164 phone number',
            );
        }
        const receiver = dto.receiver.map((r, i) => {
            const phone = toE164OrNull(r.phoneNumber);
            if (!phone) {
                throw new BadRequestException(
                    `receiver[${i}].phoneNumber must be a valid E.164 phone number`,
                );
            }
            return { ...r, phoneNumber: phone };
        });
        return {
            ...dto,
            sender: { ...dto.sender, phoneNumber: senderPhone },
            receiver,
        };
    }
}
