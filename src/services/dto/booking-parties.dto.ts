import {
    IsDateString,
    IsEmail,
    IsNotEmpty,
    IsNumber,
    IsString,
    Max,
    Min,
    ValidateNested,
    ValidatorConstraint,
    ValidatorConstraintInterface,
    ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Booking party DTOs shared by the quote + pay endpoints. Lifted verbatim from
 * the retired service-fees module — the booking still collects sender/recipient
 * addresses, the parcel, and pickup/delivery dates because fulfillment needs
 * them AND they are the quantity source for per-distance / per-weight pricing.
 */
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
    /** Weight in kilograms (canonical). per_lb items convert from this. */
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

/** Each receiver's deliveryDate must be on/after the sender's collectionDate. */
@ValidatorConstraint({ name: 'DeliveryAfterCollection', async: false })
export class DeliveryAfterCollectionConstraint
    implements ValidatorConstraintInterface
{
    validate(value: unknown, args: ValidationArguments): boolean {
        const dto = args.object as { sender?: { collectionDate?: string } };
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
