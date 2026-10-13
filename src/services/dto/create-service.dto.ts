import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    IsArray,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { PRICING_UNITS } from '../pricing';
import type { PricingUnit } from '../pricing';
import { CurrencyAmountDto } from './currency-amount.dto';

/**
 * Create a service. `amountMajor` is the admin-supplied per-unit rate in major
 * units (e.g. dollars) — it is sent to Stripe and NOT stored locally. `currency`
 * defaults to the connected account's default currency when omitted.
 * `currencyOptions` adds amounts in other currencies to the same Stripe price.
 */
export class CreateServiceDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    name: string;

    @ApiProperty({
        description: 'Per-unit rate in major units (e.g. dollars).',
    })
    @IsNumber()
    @Min(0)
    amountMajor: number;

    @ApiProperty({ enum: PRICING_UNITS })
    @IsIn(PRICING_UNITS)
    pricingUnit: PricingUnit;

    @ApiPropertyOptional({
        description: 'ISO currency code; defaults to the account default.',
    })
    @IsOptional()
    @IsString()
    currency?: string;

    @ApiPropertyOptional({
        description:
            'Shown to shoppers with the rate, e.g. at storefront checkout. ' +
            'Stored as the Stripe product description. Send an empty string ' +
            'to clear it on update.',
        maxLength: 500,
    })
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @ApiPropertyOptional({
        type: [CurrencyAmountDto],
        description:
            'Amounts in currencies other than the main one (Stripe ' +
            '`currency_options`). On update, the list replaces the stored ' +
            'set; send `[]` to remove them all.',
    })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CurrencyAmountDto)
    currencyOptions?: CurrencyAmountDto[];
}
