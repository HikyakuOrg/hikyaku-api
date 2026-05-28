import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Country is only consumed the first time we create the connected account;
 * once an account exists it is ignored (country is immutable on a Stripe
 * account). Currency is derived from account.default_currency after creation.
 */
export class CreateAccountSessionDto {
    @ApiProperty({ description: 'ISO 3166-1 alpha-2 country, e.g. "US"' })
    @IsString()
    @Length(2, 2)
    country: string;
}
