import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';
import { PRICING_UNITS } from '../pricing';
import type { PricingUnit } from '../pricing';

/**
 * Create an add-on on a service. Inherits the parent service's currency, so no
 * currency field. `amountMajor` is the per-unit rate in major units.
 */
export class CreateAddonDto {
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
}
