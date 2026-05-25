import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateEphemeralKeyDto {
    @ApiProperty({ description: 'Single-use nonce from stripe.createEphemeralKeyNonce()' })
    @IsString()
    @IsNotEmpty()
    nonce: string;

    @ApiProperty({ description: 'Stripe API version pinned by the client SDK' })
    @IsString()
    @IsNotEmpty()
    apiVersion: string;
}
