import { ApiProperty } from '@nestjs/swagger';
import { IsUrl } from 'class-validator';

export class CreateBillingPortalSessionDto {
    @ApiProperty({
        description:
            'Where Stripe redirects the browser after the customer leaves the ' +
            'Billing Portal — typically the page the "Add payment method" button ' +
            'was clicked from.',
        example: 'https://acme.hikyaku.org/dashboard/settings/billing',
    })
    @IsUrl({ require_tld: false }) // require_tld: false so http://127.0.0.1 works in local dev
    returnUrl: string;
}

export class BillingPortalSessionDto {
    @ApiProperty({ description: 'Stripe-hosted Billing Portal URL to redirect the browser to.' })
    url: string;
}
