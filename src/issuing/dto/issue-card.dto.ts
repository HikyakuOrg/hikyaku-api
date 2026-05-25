import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsIn,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    IsUUID,
    Length,
} from 'class-validator';
import { SPENDING_INTERVALS } from '../issuing.service';
import type { SpendingInterval } from '../issuing.service';

export class IssueCardDto {
    @ApiProperty({ description: 'Driver (user) id to issue the card to' })
    @IsUUID('4')
    driverId: string;

    @ApiPropertyOptional({ description: 'Vehicle to associate the card with' })
    @IsUUID('4')
    @IsOptional()
    vehicleId?: string;

    @ApiPropertyOptional({
        description: 'Major-unit spend cap, e.g. 150 for $150.00. Omit for no card-level limit.',
    })
    @IsNumber()
    @IsPositive()
    @IsOptional()
    spendingLimitMajor?: number;

    @ApiPropertyOptional({ enum: SPENDING_INTERVALS, default: 'daily' })
    @IsIn(SPENDING_INTERVALS)
    @IsOptional()
    interval?: SpendingInterval;

    @ApiProperty({
        description: 'ISO currency matching the platform Stripe account (usd/eur/gbp)',
    })
    @IsString()
    @Length(3, 3)
    currency: string;
}
