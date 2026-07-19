import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    // Preserve the unparsed body so the Stripe webhook can verify signatures.
    { rawBody: true },
  );
  
  const config = new DocumentBuilder()
    .setTitle('Whendan Logistics API')
    .setDescription('The Whendan Logistics API description')
    .setVersion('1.0')
    // Two distinct schemes are in play. PermissionGuard-protected endpoints read
    // a standard `Authorization: Bearer <jwt>`; the geocode proxy's AuthGuard
    // reads the same JWT from `x-whendan` instead. Both are declared so generated
    // clients wire the token up rather than treating it as a plain header.
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: 'x-whendan',
        in: 'header',
        description: 'Supabase JWT, sent as `Bearer <jwt>`.',
      },
      'whendanToken',
    )
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, documentFactory);

  app.enableCors({
    origin: process.env.CORS_DOMAIN?.split(',') ?? ['http://localhost:3000'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE'
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  await app.listen(process.env.PORT ?? 3002, '0.0.0.0');
}
bootstrap();
