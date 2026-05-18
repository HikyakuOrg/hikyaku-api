import {
    ArrayMinSize,
    IsDefined,
    IsArray,
    IsDateString,
    IsEmail,
    IsNotEmpty,
    IsNumber,
    IsString,
    IsUUID,
    Max,
    Min,
    Validate,
    ValidateNested,
    ValidatorConstraint,
    ValidatorConstraintInterface,
    ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class AddressDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    country: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    state: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    suburb: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    street: string;

    @ApiProperty({ minimum: -90, maximum: 90 })
    @IsNumber()
    @Min(-90)
    @Max(90)
    lat: number;

    @ApiProperty({ minimum: -180, maximum: 180 })
    @IsNumber()
    @Min(-180)
    @Max(180)
    lon: number;
}

export class ParcelDto {
    @ApiProperty({ minimum: 0 })
    @IsNumber()
    @Min(0)
    weight: number;

    @ApiProperty({ minimum: 0 })
    @IsNumber()
    @Min(0)
    height: number;

    @ApiProperty({ minimum: 0 })
    @IsNumber()
    @Min(0)
    width: number;

    @ApiProperty({ minimum: 0 })
    @IsNumber()
    @Min(0)
    length: number;
}

export class SenderDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    phoneNumber: string;

    @ApiProperty()
    @IsEmail()
    email: string;

    @ApiProperty({ type: () => AddressDto })
    @ValidateNested()
    @Type(() => AddressDto)
    address: AddressDto;

    @ApiProperty({ type: () => ParcelDto })
    @ValidateNested()
    @Type(() => ParcelDto)
    parcel: ParcelDto;

    @ApiProperty({ example: '2025-01-01', description: 'ISO date YYYY-MM-DD' })
    @IsDateString()
    collectionDate: string;
}

export class ReceiverDto {
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    phoneNumber: string;

    @ApiProperty()
    @IsEmail()
    email: string;

    @ApiProperty({ type: () => AddressDto })
    @ValidateNested()
    @Type(() => AddressDto)
    address: AddressDto;

    @ApiProperty({ example: '2025-01-03', description: 'ISO date YYYY-MM-DD' })
    @IsDateString()
    deliveryDate: string;
}

@ValidatorConstraint({ name: 'DeliveryAfterCollection', async: false })
class DeliveryAfterCollectionConstraint implements ValidatorConstraintInterface {
    validate(value: unknown, args: ValidationArguments): boolean {
        const dto = args.object as CalculateServiceFeeDto;
        const receivers = value as ReceiverDto[];
        if (!dto.sender?.collectionDate || !receivers?.length) return true;
        const collection = new Date(dto.sender.collectionDate + 'T00:00:00Z');
        if (isNaN(collection.getTime())) return true;
        return receivers.every((r) => {
            const delivery = new Date(r.deliveryDate + 'T00:00:00Z');
            if (isNaN(delivery.getTime())) return true;
            return delivery >= collection;
        });
    }

    defaultMessage(): string {
        return 'Each receiver deliveryDate must be after sender collectionDate';
    }
}

export class CalculateServiceFeeDto {
    @ApiProperty({ description: 'UUID of the service rate to apply' })
    @IsUUID()
    serviceRateId: string;

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
