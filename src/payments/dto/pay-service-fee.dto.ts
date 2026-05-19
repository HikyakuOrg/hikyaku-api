import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CalculateServiceFeeDto } from 'src/service-fees/dto/calculate-service-fee.dto';

/**
 * Body for POST /api/v1/service-fees/pay. Same shape as the fee calculation
 * (so the server can recompute the authoritative amount) plus the booking-only
 * fields needed to create the package after payment.
 */
export class PayServiceFeeDto extends CalculateServiceFeeDto {
    @ApiPropertyOptional({ description: 'Free-text notes shown to the driver' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    deliveryNotes?: string;
}
