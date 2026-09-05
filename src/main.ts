// Import this first so Sentry instruments everything loaded after it.
import './instrument';

import { NestFactory } from '@nestjs/core';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApiConfig } from './openapi.config';

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter(),
        // Preserve the unparsed body so the Stripe webhook can verify signatures.
        { rawBody: true },
    );

    // Metadata lives in openapi.config.ts
    const config = buildOpenApiConfig();
    const documentFactory = () => SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, documentFactory);

    app.enableCors({
        origin: process.env.CORS_DOMAIN?.split(',') ?? [
            'http://localhost:3000',
        ],
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    });

    app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );

    await app.listen(process.env.PORT ?? 3002, '0.0.0.0');
}
bootstrap();
