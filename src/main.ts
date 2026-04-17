// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import 'dotenv/config';
import helmet from 'helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('CommunicationsService');
  const port = Number(process.env.COMMS_SERVICE_PORT ?? '3014');

  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();
  app.use(helmet());
  app.enableCors({
    origin: process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()) ?? '*',
  });

  app.setGlobalPrefix('api/v1', {
    exclude: ['/health', '/internal/v1/*path'],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Communications Service API')
    .setDescription(
      'Internal microservice API for provisioning and managing Matrix chat rooms and ' +
      'LiveKit (or Janus) WebRTC audio/video rooms. All endpoints under `/internal/v1/` are ' +
      'protected by a service-to-service JWT (Bearer token signed with `INTERNAL_SERVICE_SECRET`).',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Internal service JWT' },
      'internal-jwt',
    )
    .addTag('Rooms', 'Room provisioning, lifecycle, mic control, and participant management')
    .addTag('Health', 'Service connectivity health check')
    .build();
  const swaggerDoc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDoc);

  await app.listen(port);

  logger.log(`Communications HTTP service running on port ${port}`);
}

bootstrap();
