import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('CommunicationsService');
  const rabbitmqUrl =
    process.env.RABBITMQ_URL ?? 'amqp://admin:admin123@localhost:5672';
  const exchange = process.env.RMQ_EXCHANGE ?? 'comms_events_fanout';
  const queue = process.env.RMQ_QUEUE ?? 'comms_events';
  const port = Number(process.env.COMMS_SERVICE_PORT ?? '3014');

  const app = await NestFactory.create(AppModule);

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
      'Janus WebRTC audio/video rooms. All endpoints under `/internal/v1/` are ' +
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

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      exchange,
      exchangeType: 'fanout',
      queue,
      queueOptions: { durable: true },
      noAck: false,
      prefetchCount: 5,
    },
  });

  await app.startAllMicroservices();
  await app.listen(port);

  logger.log(`Communications HTTP service running on port ${port}`);
  logger.log(`Communications RMQ consumer listening on ${queue}`);
}

bootstrap();
