import { ApiProperty } from '@nestjs/swagger';
import type { ConnectStatus, OrgIssuingStatus } from '../connect.service';

/**
 * Swagger view of the results in `connect.service.ts`. The interfaces there stay
 * the source of truth; `implements` is what stops the two drifting.
 */

/** 200 body of POST /api/v1/connect/account-session. */
export class AccountSessionDto {
    @ApiProperty({
        description:
            'Account Session client secret for @stripe/connect-js. Single-use and ' +
            'short-lived — fetch a fresh one per mount rather than caching it.',
        example: '_RGnKPHVCJhLYYDbYDVLBOoM0YWczOTdmYTBl',
    })
    clientSecret: string;

    @ApiProperty({
        description:
            'The platform’s Stripe publishable key, returned so the frontend need ' +
            'not carry it separately.',
        example: 'pk_test_51QhX1a2B3c4D5e6',
    })
    publishableKey: string;
}

/**
 * 200 body of GET /api/v1/connect/status.
 *
 * Read live from Stripe. An organisation that has not started onboarding gets
 * every field null or false rather than a 404, so the settings screen can render
 * the "not set up" state without special-casing.
 */
export class ConnectStatusDto implements ConnectStatus {
    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Connected account id, or null before onboarding begins.',
        example: 'acct_1QhX1a2B3c4D5e6',
    })
    accountId: string | null;

    @ApiProperty({
        description: 'Whether the org finished Stripe’s onboarding form.',
    })
    detailsSubmitted: boolean;

    @ApiProperty({
        description:
            'Whether the account can take payments. Gates the service-rates and ' +
            'booking features.',
    })
    chargesEnabled: boolean;

    @ApiProperty({ description: 'Whether Stripe will pay out to the account.' })
    payoutsEnabled: boolean;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'Stripe capability state — `active`, `pending`, `inactive`, or null ' +
            'when never requested. Fuel cards need `active`.',
        example: 'active',
    })
    cardIssuingStatus: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'ISO 3166-1 alpha-2 country, fixed at account creation and immutable ' +
            'afterwards.',
        example: 'US',
    })
    country: string | null;

    @ApiProperty({
        type: String,
        nullable: true,
        description: 'Account default currency, lower-case ISO 4217.',
        example: 'usd',
    })
    currency: string | null;
}

/** One entry of GET /api/v1/connect/issuing-statuses — powers the org switcher. */
export class OrgIssuingStatusDto implements OrgIssuingStatus {
    @ApiProperty({
        description: 'Organisation slug.',
        example: 'acme-logistics',
    })
    slug: string;

    @ApiProperty({
        type: String,
        nullable: true,
        description:
            'As on the status endpoint. Null when the org has no account.',
        example: 'active',
    })
    cardIssuingStatus: string | null;

    @ApiProperty()
    detailsSubmitted: boolean;

    @ApiProperty({
        description:
            'Whether the connected account can accept payments — gates "Service ' +
            'Rates".',
    })
    chargesEnabled: boolean;
}

/** Where the organisation wires money to top up its Issuing balance. */
export class FundingBankTransferDto {
    @ApiProperty({
        description: 'ISO 3166-1 alpha-2 country of the receiving bank.',
        example: 'US',
    })
    country: string;

    @ApiProperty({
        description:
            'Transfer rail, derived from the account currency — one of ' +
            '`us_bank_transfer`, `gb_bank_transfer`, `eu_bank_transfer`.',
        example: 'us_bank_transfer',
    })
    type: string;

    @ApiProperty({
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description:
            'Bank coordinates to wire to. The fields vary by rail — ACH exposes ' +
            'routing and account numbers, SEPA an IBAN — so this is left opaque ' +
            'rather than modelled per country. Render it, do not branch on it.',
    })
    financial_addresses: Record<string, unknown>[];
}

/**
 * 200 body of POST /api/v1/connect/funding-instructions.
 *
 * A verbatim passthrough of Stripe's `issuing/funding_instructions`, which the
 * Stripe SDK does not type — this API forwards the raw response without
 * reshaping it. The fields below are the ones the dashboard relies on; Stripe
 * may include others (`object`, `livemode`, `funding_type`), and this schema
 * neither strips nor guarantees them.
 *
 * A POST, despite reading rather than writing, because Stripe's own endpoint is
 * one: calling it can provision bank coordinates on first use.
 */
export class FundingInstructionsDto {
    @ApiProperty({
        description: 'Lower-case ISO 4217 code the account is funded in.',
        example: 'usd',
    })
    currency: string;

    @ApiProperty({ type: FundingBankTransferDto })
    bank_transfer: FundingBankTransferDto;
}

/** One currency's spendable Issuing balance. */
export class IssuingBalanceDto {
    @ApiProperty({
        description:
            'Available to spend, in minor units. Can be zero, and is not the ' +
            'account’s payments balance — Issuing funds are held separately.',
        example: 250000,
    })
    amount: number;

    @ApiProperty({ description: 'Lower-case ISO 4217 code.', example: 'usd' })
    currency: string;
}
