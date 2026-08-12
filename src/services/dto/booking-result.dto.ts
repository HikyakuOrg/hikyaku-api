import { ApiProperty } from '@nestjs/swagger';
import { PRICING_UNITS } from '../pricing';
import type {
    CheckoutResult,
    QuoteLine,
    QuoteResponse,
} from '../booking.service';

/**
 * Swagger view of the booking results in `booking.service.ts`. As with the
 * catalog DTOs, the interfaces there stay authoritative and `implements` is what
 * stops the two drifting.
 */

/** One priced line of a quote: the item, how much of it, and what that costs. */
export class QuoteLineDto implements QuoteLine {
    @ApiProperty({
        description: 'Stripe product id of the service or add-on this line bills.',
        example: 'prod_QhX1a2B3c4D5e6',
    })
    id: string;

    @ApiProperty({ example: 'Same-day courier' })
    name: string;

    @ApiProperty({ enum: PRICING_UNITS, example: 'per_km' })
    pricing_unit: string;

    @ApiProperty({
        description:
            'Per-unit rate in major units (e.g. dollars), for display beside the ' +
            'quantity. Derived from the Stripe price.',
        example: 12.5,
    })
    rate: number;

    @ApiProperty({
        description:
            'Units billed, derived server-side from the booking: 1 for ' +
            '`per_delivery`, the recipient count for `per_recipient`, and the ' +
            'measured route distance or parcel weight otherwise. Fractional for ' +
            'the distance and weight units.',
        example: 8.4,
    })
    quantity: number;

    @ApiProperty({
        description: 'Line total in minor units — `rate × quantity`, rounded.',
        example: 10500,
    })
    amount_minor: number;
}

/**
 * 200 body of POST /api/v1/services/quote.
 *
 * Server-authoritative and free of side effects: no charge is taken and nothing
 * is persisted. Distance-priced lines cause a live routing call, so a quote is
 * not free to compute — it is not a substitute for client-side arithmetic on the
 * catalog.
 */
export class QuoteResultDto implements QuoteResponse {
    @ApiProperty({
        description:
            'Lower-case ISO 4217 code shared by every line, taken from the first ' +
            'line. Falls back to `usd` for an empty quote.',
        example: 'usd',
    })
    currency: string;

    @ApiProperty({
        type: [QuoteLineDto],
        description:
            'The chosen service first, then each selected add-on in the order it ' +
            'was requested.',
    })
    lines: QuoteLineDto[];

    @ApiProperty({
        description: 'Sum of every line’s `amount_minor`.',
        example: 11750,
    })
    total_minor: number;

    @ApiProperty({
        description:
            '`total_minor` expressed in major units, for display. Never use it to ' +
            'reconcile against Stripe — `total_minor` is the exact figure.',
        example: 117.5,
    })
    total: number;
}

/**
 * 200 body of POST /api/v1/services/pay.
 *
 * The booking is not complete at this point: the price is recomputed
 * server-side, a Stripe Checkout Session is opened on the organisation's
 * connected account, and a `pending` payment is recorded. The customer and
 * package are created later, by the Stripe webhook, once payment settles.
 */
export class CheckoutResultDto implements CheckoutResult {
    @ApiProperty({
        description:
            'Stripe-hosted Checkout URL. Redirect the browser to it — do not ' +
            'fetch or embed it.',
        example: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5',
    })
    checkoutUrl: string;

    @ApiProperty({
        description:
            'Checkout Session id, echoed back to the success URL as ' +
            '`session_id` so the confirmation page can identify the booking.',
        example: 'cs_test_a1B2c3D4e5',
    })
    sessionId: string;
}
