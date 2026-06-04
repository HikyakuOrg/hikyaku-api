import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ArrayMinSize,
    IsArray,
    IsDefined,
    IsOptional,
    IsUUID,
    Validate,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
    DeliveryAfterCollectionConstraint,
    ReceiverDto,
    SenderDto,
} from './booking-parties.dto';

/**
 * Body for POST /api/v1/services/quote. The org is resolved from the x-org-slug
 * header (public endpoint). Quantity for each priced item is derived from the
 * sender/recipient addresses (distance), the parcel (weight) and recipient count
 * — so those are all required even though no charge is taken.
 */
export class QuoteBookingDto {
    @ApiProperty({ description: 'UUID of the chosen service.' })
    @IsUUID()
    serviceId: string;

    @ApiPropertyOptional({ type: [String], description: 'Selected add-on UUIDs.' })
    @IsOptional()
    @IsArray()
    @IsUUID('all', { each: true })
    addonIds?: string[];

    @ApiProperty({ type: () => SenderDto })
    @IsDefined()
    @ValidateNested()
    @Type(() => SenderDto)
    sender: SenderDto;

    @ApiProperty({ type: [ReceiverDto], minItems: 1 })
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => ReceiverDto)
    @Validate(DeliveryAfterCollectionConstraint)
    receiver: ReceiverDto[];
}
