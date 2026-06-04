import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { QuoteBookingDto } from './quote-booking.dto';

/**
 * Body for POST /api/v1/services/pay. Same shape as the quote (so the server can
 * recompute the authoritative amount) plus the booking-only `deliveryNotes`
 * carried through to the package created at fulfillment.
 */
export class PayBookingDto extends QuoteBookingDto {
    @ApiPropertyOptional({ description: 'Free-text notes shown to the driver.' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    deliveryNotes?: string;
}
