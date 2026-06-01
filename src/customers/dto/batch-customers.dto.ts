import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ArrayMinSize } from 'class-validator';

export class BatchByDbIdsDto {
    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    ids: string[];
}

export class BatchByStripeIdsDto {
    @ApiProperty({ type: [String] })
    @IsArray()
    @ArrayMinSize(1)
    @IsString({ each: true })
    stripeIds: string[];
}
