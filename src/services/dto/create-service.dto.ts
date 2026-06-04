import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
} from 'class-validator';
import { PRICING_UNITS } from '../pricing';
import type { PricingUnit } from '../pricing';

/**
 * Create a service. `amountMajor` is the admin-supplied per-unit rate in major
 * units (e.g. dollars) — it is sent to Stripe and NOT stored locally. `currency`
 * defaults to the connected account's default currency when omitted.
 */
export class CreateServiceDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    @MaxLength(200)
    name: string;

    @ApiProperty({ description: 'Per-unit rate in major units (e.g. dollars).' })
    @IsNumber()
    @Min(0)
    amountMajor: number;

    @ApiProperty({ enum: PRICING_UNITS })
    @IsIn(PRICING_UNITS)
    pricingUnit: PricingUnit;

    @ApiPropertyOptional({ description: 'ISO currency code; defaults to the account default.' })
    @IsOptional()
    @IsString()
    currency?: string;
}
