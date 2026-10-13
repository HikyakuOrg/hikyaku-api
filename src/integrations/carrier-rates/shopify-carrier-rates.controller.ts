import {
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { CarrierRatesService } from './carrier-rates.service';
import {
    verifyShopifyHmac,
    type CarrierRateRequest,
    type CarrierRateResponse,
} from './carrier-rates';

/** See StripeWebhookController for why this is declared locally. */
interface RawBodyRequest {
    rawBody?: Buffer;
}

/**
 * The URL a shop's Shopify carrier service calls at checkout. The one
 * platform-named route in integrations: Shopify calls hikyaku-api directly,
 * in its own request format, so there is no connector in between to
 * translate it.
 *
 * Unauthenticated by design. Trust comes from the HMAC Shopify signs the raw
 * body with, using the app's client secret (SHOPIFY_API_SECRET). The shop
 * header is read only after the signature checks out.
 */
@Controller('api/v1/integrations/shopify')
export class ShopifyCarrierRatesController {
    private readonly logger = new Logger(ShopifyCarrierRatesController.name);

    constructor(private readonly carrierRates: CarrierRatesService) {}

    @Post('carrier-rates')
    @HttpCode(HttpStatus.OK)
    @ApiExcludeEndpoint()
    async rates(
        @Req() req: RawBodyRequest,
        @Headers('x-shopify-hmac-sha256') hmac: string | undefined,
        @Headers('x-shopify-shop-domain') shopDomain: string | undefined,
    ): Promise<CarrierRateResponse> {
        const secret = process.env.SHOPIFY_API_SECRET;
        if (!secret) {
            this.logger.error('SHOPIFY_API_SECRET is not set');
            throw new UnauthorizedException();
        }
        if (!req.rawBody || !verifyShopifyHmac(req.rawBody, hmac, secret)) {
            throw new UnauthorizedException('Invalid HMAC');
        }
        if (!shopDomain) return { rates: [] };

        let body: CarrierRateRequest;
        try {
            body = JSON.parse(
                req.rawBody.toString('utf8'),
            ) as CarrierRateRequest;
        } catch {
            return { rates: [] };
        }
        return this.carrierRates.rates(shopDomain, body);
    }
}
