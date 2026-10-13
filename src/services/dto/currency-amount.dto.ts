import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Matches, Min } from 'class-validator';

/**
 * An amount for a price in a currency other than its main one, stored on the
 * Stripe price's `currency_options`. Used where a shop in another currency
 * must be quoted without FX conversion.
 */
export class CurrencyAmountDto {
    @ApiProperty({
        description: 'ISO 4217 code, any case. Not the main currency.',
        example: 'eur',
    })
    @Matches(/^[A-Za-z]{3}$/, {
        message: 'currency must be a three-letter ISO 4217 code',
    })
    currency: string;

    @ApiProperty({
        description: 'Per-unit rate in this currency’s major units.',
        example: 11.5,
    })
    @IsNumber()
    @Min(0)
    amountMajor: number;
}
