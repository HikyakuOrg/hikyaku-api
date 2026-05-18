import { ApiProperty } from '@nestjs/swagger';

export class ServiceRateSummaryDto {
    @ApiProperty() id: string;
    @ApiProperty() name: string;
}

export class DistanceBreakdownDto {
    @ApiProperty() total: number;
    @ApiProperty() unit: string;
    @ApiProperty() rate_per_unit: number;
    @ApiProperty() cost: number;
}

export class SignatureBreakdownDto {
    @ApiProperty() applies: boolean;
    @ApiProperty() charge_per_receiver: number;
    @ApiProperty() receiver_count: number;
    @ApiProperty() cost: number;
}

export class StorageReceiverDto {
    @ApiProperty() name: string;
    @ApiProperty() days: number;
    @ApiProperty() cost: number;
}

export class StorageBreakdownDto {
    @ApiProperty() applies: boolean;
    @ApiProperty() rate_per_day: number;
    @ApiProperty({ type: [StorageReceiverDto] }) receivers: StorageReceiverDto[];
    @ApiProperty() cost: number;
}

export class FeeBreakdownDto {
    @ApiProperty() base_rate: number;
    @ApiProperty({ type: () => DistanceBreakdownDto }) distance: DistanceBreakdownDto;
    @ApiProperty({ type: () => SignatureBreakdownDto }) signature: SignatureBreakdownDto;
    @ApiProperty({ type: () => StorageBreakdownDto }) storage: StorageBreakdownDto;
}

export class ServiceFeeResponseDto {
    @ApiProperty() currency: string;
    @ApiProperty({ type: () => ServiceRateSummaryDto }) service_rate: ServiceRateSummaryDto;
    @ApiProperty({ type: () => FeeBreakdownDto }) breakdown: FeeBreakdownDto;
    @ApiProperty() total: number;
}
