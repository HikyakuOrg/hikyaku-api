import { createHmac } from 'crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';
import { CarrierRatesService } from './carrier-rates.service';
import { ShopifyCarrierRatesController } from './shopify-carrier-rates.controller';

const SECRET = 'shpss_test';
const URL = '/api/v1/integrations/shopify/carrier-rates';

describe('ShopifyCarrierRatesController (integration)', () => {
    let app: NestFastifyApplication;
    let rates: jest.Mock;

    beforeEach(async () => {
        process.env.SHOPIFY_API_SECRET = SECRET;
        rates = jest.fn().mockResolvedValue({
            rates: [{ service_code: 'hikyaku:prod_1' }],
        });
        const module = await Test.createTestingModule({
            controllers: [ShopifyCarrierRatesController],
            providers: [{ provide: CarrierRatesService, useValue: { rates } }],
        }).compile();
        app = module.createNestApplication<NestFastifyApplication>(
            new FastifyAdapter(),
            { rawBody: true },
        );
        // As in main.ts: an untyped body must get past the global pipe.
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
        );
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
    });

    afterEach(async () => {
        await app.close();
        delete process.env.SHOPIFY_API_SECRET;
    });

    const body = JSON.stringify({
        rate: { currency: 'AUD', unknown_field: { nested: true } },
    });
    const sign = (raw: string, secret = SECRET) =>
        createHmac('sha256', secret).update(raw).digest('base64');

    it('verifies the HMAC and prices the parsed body for the shop', async () => {
        const res = await request(app.getHttpServer())
            .post(URL)
            .set('Content-Type', 'application/json')
            .set('X-Shopify-Hmac-Sha256', sign(body))
            .set('X-Shopify-Shop-Domain', 'store.myshopify.com')
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            rates: [{ service_code: 'hikyaku:prod_1' }],
        });
        expect(rates).toHaveBeenCalledWith('store.myshopify.com', {
            rate: { currency: 'AUD', unknown_field: { nested: true } },
        });
    });

    it('401s on a bad or missing HMAC without pricing', async () => {
        for (const hmac of [sign(body, 'wrong'), undefined]) {
            const req = request(app.getHttpServer())
                .post(URL)
                .set('Content-Type', 'application/json')
                .set('X-Shopify-Shop-Domain', 'store.myshopify.com');
            if (hmac) req.set('X-Shopify-Hmac-Sha256', hmac);
            const res = await req.send(body);
            expect(res.status).toBe(401);
        }
        expect(rates).not.toHaveBeenCalled();
    });

    it('401s when the API has no secret configured', async () => {
        delete process.env.SHOPIFY_API_SECRET;
        const res = await request(app.getHttpServer())
            .post(URL)
            .set('Content-Type', 'application/json')
            .set('X-Shopify-Hmac-Sha256', sign(body))
            .send(body);
        expect(res.status).toBe(401);
    });

    it('answers no rates without a shop header', async () => {
        const res = await request(app.getHttpServer())
            .post(URL)
            .set('Content-Type', 'application/json')
            .set('X-Shopify-Hmac-Sha256', sign(body))
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ rates: [] });
    });
});
