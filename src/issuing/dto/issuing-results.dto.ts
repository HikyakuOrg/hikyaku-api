import { ApiProperty } from '@nestjs/swagger';
import { SPENDING_INTERVALS } from '../issuing.service';
import type { CardDto, TransactionDto } from '../issuing.service';

/**
 * Swagger view of the wire shapes in `issuing.service.ts`. The interfaces there
 * stay the source of truth; `implements` is what stops the two drifting.
 *
 * Cards and transactions are read live from Stripe on every request — the local
 * table holds only the (org, driver, card) linkage — so these are projections of
 * Stripe objects, not rows.
 */

/** A virtual fuel card, restricted to fuel merchant categories by Stripe. */
export class IssuingCardDto implements CardDto {
    @ApiProperty({
        description: 'Stripe card id — the same value as `stripeCardId`.',
        example: 'ic_1QhX1a2B3c4D5e6',
    })
    id: string;

    @ApiProperty({ format: 'uuid' })
    organisationId: string;

    @ApiProperty({
        description:
            'Stripe cardholder id for the driver. Empty string in the unlikely ' +
            'case Stripe returned no cardholder.',
        example: 'ich_1QhX1a2B3c4D5e6',
    })
    cardholderId: string;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description:
            'Vehicle the card is associated with, from Stripe card metadata. ' +
            'Null when the card was issued without one.',
    })
    vehicleId: string | null;

    @ApiProperty({
        description: 'Stripe card id. Duplicates `id`; kept for clarity at call sites.',
        example: 'ic_1QhX1a2B3c4D5e6',
    })
    stripeCardId: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Last four digits of the PAN. The full number never leaves Stripe.',
        example: '4242',
    })
    last4: string | null;

    @ApiProperty({
        description: 'Always `virtual` — physical cards are not issued.',
        example: 'virtual',
    })
    type: string;

    @ApiProperty({ description: 'Lower-case ISO 4217 code.', example: 'usd' })
    currency: string;

    @ApiProperty({
        description:
            'Stripe card status: `active`, `inactive` (frozen) or `canceled` ' +
            '(permanent).',
        example: 'active',
    })
    status: string;

    @ApiProperty({
        type: Number,
        nullable: true,
        description:
            'Spend cap in minor units for the interval below. Null when the card ' +
            'carries no card-level limit.',
        example: 15000,
    })
    spendingLimitMinor: number | null;

    @ApiProperty({
        type: String,
        enum: SPENDING_INTERVALS,
        nullable: true,
        description: 'Window the limit resets over. Null when there is no limit.',
        example: 'daily',
    })
    spendingInterval: string | null;

    @ApiProperty({ format: 'date-time' })
    createdAt: string;

    @ApiProperty({
        format: 'date-time',
        description:
            'Stripe exposes no update timestamp on cards, so this mirrors ' +
            '`createdAt` to keep the shape stable. Do not treat it as a real ' +
            'modification time.',
    })
    updatedAt: string;
}

/** A settled fuel-card transaction. */
export class IssuingTransactionDto implements TransactionDto {
    @ApiProperty({
        description: 'Stripe transaction id — the same value as `stripeTransactionId`.',
        example: 'ipi_1QhX1a2B3c4D5e6',
    })
    id: string;

    @ApiProperty({ format: 'uuid' })
    organisationId: string;

    @ApiProperty({ type: String, nullable: true, example: 'ic_1QhX1a2B3c4D5e6' })
    cardId: string | null;

    @ApiProperty({ type: String, nullable: true, example: 'ich_1QhX1a2B3c4D5e6' })
    cardholderId: string | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'From the card’s Stripe metadata; null if the card has no vehicle.',
    })
    vehicleId: string | null;

    @ApiProperty({
        type: String,
        format: 'uuid',
        nullable: true,
        description: 'From the cardholder’s Stripe metadata.',
    })
    driverId: string | null;

    @ApiProperty({ example: 'ipi_1QhX1a2B3c4D5e6' })
    stripeTransactionId: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'The authorization this transaction settled, where there was one.',
    })
    stripeAuthorizationId: string | null;

    @ApiProperty({
        enum: ['capture', 'refund'],
        description: 'Anything Stripe does not report as a refund is a capture.',
        example: 'capture',
    })
    type: string;

    @ApiProperty({
        description:
            'Magnitude in minor units, always positive. Stripe reports spend as a ' +
            'negative amount; the sign is dropped here, so use `type` to tell a ' +
            'refund from a capture.',
        example: 6350,
    })
    amountMinor: number;

    @ApiProperty({ description: 'Lower-case ISO 4217 code.', example: 'usd' })
    currency: string;

    @ApiProperty({ type: String, nullable: true, example: 'SHELL 1234' })
    merchantName: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Stripe merchant category, e.g. `service_stations`.',
        example: 'service_stations',
    })
    merchantCategory: string | null;

    @ApiProperty({ type: String, nullable: true })
    merchantCity: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'ISO 3166-1 alpha-2 country code.',
        example: 'US',
    })
    merchantCountry: string | null;

    @ApiProperty({
        type: String,
        format: 'date-time',
        nullable: true,
        description: 'Mirrors `createdAt` — Stripe exposes one timestamp here.',
    })
    authorizedAt: string | null;

    @ApiProperty({ format: 'date-time' })
    createdAt: string;
}

/** 200 body of POST /api/v1/issuing/cards/{id}/ephemeral-key. */
export class EphemeralKeyDto {
    @ApiProperty({
        description:
            'Short-lived Stripe ephemeral key secret. Pass it straight to Issuing ' +
            'Elements to render full card details client-side — the PAN never ' +
            'touches this server. Do not log or persist it.',
        example: 'ek_test_YWNjdF8xUWhYMWEyQjNjNEQ1ZTY',
    })
    ephemeralKeySecret: string;
}
