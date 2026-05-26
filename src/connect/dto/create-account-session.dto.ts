import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Country + currency are only consumed the first time we create the connected
 * account; once an account exists they're ignored (the account is immutable on
 * country). Orgs are global, so the admin picks these at onboarding.
 */
export class CreateAccountSessionDto {
    @ApiProperty({ description: 'ISO 3166-1 alpha-2 country, e.g. "US"' })
    @IsString()
    @Length(2, 2)
    country: string;

    @ApiProperty({ description: 'ISO 4217 currency, e.g. "usd"' })
    @IsString()
    @Length(3, 3)
    currency: string;
}
