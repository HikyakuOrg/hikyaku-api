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
    // Every guard (PermissionGuard, AuthGuard) reads the same standard
    // `Authorization: Bearer <jwt>` — a single scheme covers all of them so
    // generated clients wire the token up rather than treating it as a plain
    // header.
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
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
