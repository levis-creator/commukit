import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';

/**
 * Fire-and-forget RabbitMQ event publisher for the communications service.
 *
 * Connects to the configured fanout exchange on startup and exposes a single
 * [publish] method for emitting domain events. Connection failures are
 * treated as non-fatal: if RabbitMQ is unavailable, events are silently
 * dropped with a debug log rather than throwing — callers should not depend
 * on delivery guarantees from this service.
 *
 * Events published:
 * - `communications.room.provisioned`
 * - `communications.room.activated`
 * - `communications.room.closed`
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger(MessagingService.name);
  private client: ClientProxy | null = null;
  private available = false;

  /**
   * Establishes the RabbitMQ publisher connection at module startup.
   * A failed connection sets `available = false` so [publish] silently no-ops
   * rather than crashing the service.
   */
  async onModuleInit() {
    const rabbitmqUrl = process.env.RABBITMQ_URL ?? 'amqp://admin:admin123@localhost:5672';
    try {
      this.client = ClientProxyFactory.create({
        transport: Transport.RMQ,
        options: {
          urls: [rabbitmqUrl],
          exchange: process.env.RMQ_EXCHANGE ?? 'comms_events_fanout',
          exchangeType: 'fanout',
          queue: '',
          queueOptions: { durable: false, exclusive: true },
          persistent: true,
        },
      });
      await this.client.connect();
      this.available = true;
      this.logger.log('RabbitMQ publisher connected');
    } catch (err) {
      this.logger.warn(`RabbitMQ publisher failed to connect: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Emit a domain event onto the RabbitMQ fanout exchange.
   *
   * This is a best-effort, fire-and-forget call. If the broker is unavailable
   * the event is dropped with a debug log — no error is thrown.
   *
   * @param pattern - Event routing key (e.g. `"communications.room.provisioned"`).
   * @param data    - Event payload serialized as JSON.
   */
  publish<T extends object>(pattern: string, data: T): void {
    if (!this.available || !this.client) {
      this.logger.debug(`Skipping event ${pattern} — RabbitMQ unavailable`);
      return;
    }
    this.client.emit(pattern, data).subscribe({
      error: (err) => this.logger.warn(`Failed to publish ${pattern}: ${err}`),
    });
  }
}
