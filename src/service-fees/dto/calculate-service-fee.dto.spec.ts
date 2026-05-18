import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request = require('supertest');
import { ServiceFeesController } from '../service-fees.controller';
import { ServiceFeesService } from '../service-fees.service';
import { AuthGuard } from 'src/auth/guards/auth.guard';

const VALID_UUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

const VALID_ADDRESS = {
    country: 'Australia',
    state: 'NSW',
    suburb: 'Sydney',
    street: '1 Main St',
    lat: -33.8688,
    lon: 151.2093,
};

const VALID_BODY = {
    serviceRateId: VALID_UUID,
    sender: {
        name: 'Alice',
        phoneNumber: '+61400000000',
        email: 'alice@example.com',
        address: VALID_ADDRESS,
        parcel: { weight: 2, height: 10, width: 10, length: 20 },
        collectionDate: '2025-06-01',
    },
    receiver: [
        {
            name: 'Bob',
            phoneNumber: '+61400000001',
            email: 'bob@example.com',
            address: { ...VALID_ADDRESS, lat: -33.9, lon: 151.1 },
            deliveryDate: '2025-06-03',
        },
    ],
};

const mockServiceFeesService = {
    calculate: jest.fn().mockResolvedValue({}),
};

async function buildApp(): Promise<INestApplication> {
    const module: TestingModule = await Test.createTestingModule({
        controllers: [ServiceFeesController],
        providers: [{ provide: ServiceFeesService, useValue: mockServiceFeesService }],
    })
        .overrideGuard(AuthGuard)
        .useValue({ canActivate: jest.fn().mockReturnValue(true) })
        .compile();

    const app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    return app;
}

describe('POST /api/v1/service-fees/calculate (DTO validation)', () => {
    let app: INestApplication;

    beforeEach(async () => {
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
        jest.clearAllMocks();
    });

    it('returns 200 on a valid payload', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send(VALID_BODY)
            .expect(200);
    });

    it('returns 400 when serviceRateId is missing', () => {
        const { serviceRateId: _, ...body } = VALID_BODY;
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send(body)
            .expect(400);
    });

    it('returns 400 when serviceRateId is not a UUID', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({ ...VALID_BODY, serviceRateId: 'not-a-uuid' })
            .expect(400);
    });

    it('returns 400 when sender is missing', () => {
        const { sender: _, ...body } = VALID_BODY;
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send(body)
            .expect(400);
    });

    it('returns 400 when sender.collectionDate is wrong format', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({
                ...VALID_BODY,
                sender: { ...VALID_BODY.sender, collectionDate: '01/06/2025' },
            })
            .expect(400);
    });

    it('returns 400 when sender.address.lat is out of range', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({
                ...VALID_BODY,
                sender: {
                    ...VALID_BODY.sender,
                    address: { ...VALID_ADDRESS, lat: 200 },
                },
            })
            .expect(400);
    });

    it('returns 400 when sender.address.lon is out of range', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({
                ...VALID_BODY,
                sender: {
                    ...VALID_BODY.sender,
                    address: { ...VALID_ADDRESS, lon: -200 },
                },
            })
            .expect(400);
    });

    it('returns 400 when receiver is an empty array', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({ ...VALID_BODY, receiver: [] })
            .expect(400);
    });

    it('returns 400 when receiver[0].deliveryDate is wrong format', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({
                ...VALID_BODY,
                receiver: [{ ...VALID_BODY.receiver[0], deliveryDate: 'not-a-date' }],
            })
            .expect(400);
    });

    it('returns 400 when receiver[0].deliveryDate is before collectionDate', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({
                ...VALID_BODY,
                receiver: [{ ...VALID_BODY.receiver[0], deliveryDate: '2025-05-30' }],
            })
            .expect(400);
    });

    it('returns 400 when receiver[0].deliveryDate equals collectionDate', () => {
        return request(app.getHttpServer())
            .post('/api/v1/service-fees/calculate')
            .send({
                ...VALID_BODY,
                receiver: [{ ...VALID_BODY.receiver[0], deliveryDate: '2025-06-01' }],
            })
            .expect(400);
    });
});
