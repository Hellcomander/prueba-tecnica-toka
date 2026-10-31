import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CORRELATION_HEADER, EVENTS_EXCHANGE, type EventEnvelope, type QueueDefinition } from '@toka/contracts';
import * as amqp from 'amqp-connection-manager';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { ClsService } from 'nestjs-cls';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLS_CAUSATION_ID, CLS_CORRELATION_ID } from '../../context/request-context';
import type { EventPublisher } from '../../messaging/event-publisher';
import { applyOutcome, processMessage } from '../../messaging/message-processing';
import { declareTopology } from '../../messaging/topology';

export interface MessagingOptions {
  url: string;
  /** Colas que este servicio consume (se declaran al conectar). */
  queues?: readonly QueueDefinition[];
  prefetch?: number;
  publishTimeoutMs?: number;
}

export const MESSAGING_OPTIONS = Symbol('MESSAGING_OPTIONS');

/**
 * Adaptador de RabbitMQ (amqp-connection-manager): reconexión automática, canal de publicación
 * con publisher confirms y un canal por consumidor que re-suscribe al reconectar. La lógica de
 * reintento/DLQ vive en messaging/message-processing.ts (probada con tests unitarios); este
 * archivo solo la conecta al broker y lo cubre el smoke test.
 */
@Injectable()
export class AmqpConnection implements OnModuleInit, OnApplicationShutdown {
  private connection?: amqp.AmqpConnectionManager;
  private publisher?: ChannelWrapper;
  private readonly consumers: ChannelWrapper[] = [];

  constructor(
    @Inject(MESSAGING_OPTIONS) private readonly options: MessagingOptions,
    @InjectPinoLogger(AmqpConnection.name) private readonly logger: PinoLogger,
    private readonly cls: ClsService,
  ) {}

  onModuleInit(): void {
    this.connection = amqp.connect([this.options.url], { heartbeatIntervalInSeconds: 15, reconnectTimeInSeconds: 2 });
    this.connection.on('connect', () => this.logger.info({ event: 'amqp.connected' }, 'amqp.connected'));
    this.connection.on('disconnect', ({ err }) => this.logger.warn({ event: 'amqp.disconnected', err }, 'amqp.disconnected'));
    this.publisher = this.connection.createChannel({
      name: 'publisher',
      confirm: true,
      publishTimeout: this.options.publishTimeoutMs ?? 5_000,
      setup: (channel: ConfirmChannel) => declareTopology(channel, this.options.queues ?? []),
    });
  }

  isConnected(): boolean {
    return this.connection?.isConnected() ?? false;
  }

  /** Resuelve cuando el canal de publicación está conectado y la topología declarada. */
  async waitUntilReady(): Promise<void> {
    await this.publisher?.waitForConnect();
  }

  async publish(event: EventEnvelope): Promise<void> {
    if (!this.publisher) throw new Error('AmqpConnection no inicializada');
    await this.publisher.publish(EVENTS_EXCHANGE, event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
      messageId: event.eventId,
      type: event.type,
      correlationId: event.correlationId,
      timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
      headers: { [CORRELATION_HEADER]: event.correlationId },
    });
  }

  /** Registra un consumidor; la promesa resuelve cuando su cola está declarada y suscrita. */
  consume<TEvent extends { eventId: string; type: string; correlationId: string }>(
    queue: QueueDefinition,
    parse: (raw: unknown) => TEvent,
    handler: (event: TEvent) => Promise<void>,
  ): Promise<void> {
    if (!this.connection) throw new Error('AmqpConnection no inicializada');
    const channel = this.connection.createChannel({
      name: `consumer:${queue.name}`,
      setup: async (ch: ConfirmChannel) => {
        await declareTopology(ch, [queue]);
        await ch.prefetch(this.options.prefetch ?? 10);
        await ch.consume(queue.name, (message) => {
          if (message) void this.handle(ch, queue.name, message, parse, handler);
        });
      },
    });
    this.consumers.push(channel);
    return channel.waitForConnect();
  }

  private async handle<TEvent extends { eventId: string; type: string; correlationId: string }>(
    channel: ConfirmChannel,
    queue: string,
    message: ConsumeMessage,
    parse: (raw: unknown) => TEvent,
    handler: (event: TEvent) => Promise<void>,
  ): Promise<void> {
    const started = Date.now();
    const outcome = await processMessage(message, parse, handler, (ctx, fn) =>
      this.cls.run(async () => {
        this.cls.set(CLS_CORRELATION_ID, ctx.correlationId);
        this.cls.set(CLS_CAUSATION_ID, ctx.causationId);
        await fn();
      }),
    );
    const base = { queue, routingKey: message.fields.routingKey, eventId: outcome.eventId, durationMs: Date.now() - started };
    if (outcome.action === 'ack') this.logger.info({ event: 'amqp.message.consumed', ...base }, 'amqp.message.consumed');
    else if (outcome.action === 'retry')
      this.logger.warn({ event: 'amqp.message.retried', ...base, attempt: outcome.nextAttempt, err: outcome.error }, 'amqp.message.retried');
    else this.logger.error({ event: 'amqp.message.dead_lettered', ...base, attempt: outcome.attempt, err: outcome.error }, 'amqp.message.dead_lettered');
    applyOutcome(channel, queue, message, outcome);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.consumers.map((c) => c.close()));
    await this.publisher?.close();
    await this.connection?.close();
  }
}

/** EventPublisher sobre RabbitMQ. No lanza: si no hay confirmación, registra el evento completo. */
@Injectable()
export class AmqpEventPublisher implements EventPublisher {
  constructor(
    private readonly amqpConnection: AmqpConnection,
    @InjectPinoLogger(AmqpEventPublisher.name) private readonly logger: PinoLogger,
  ) {}

  async publish(event: EventEnvelope): Promise<void> {
    try {
      await this.amqpConnection.publish(event);
      this.logger.debug({ event: 'amqp.published', eventId: event.eventId, type: event.type }, 'amqp.published');
    } catch (err) {
      this.logger.error({ event: 'amqp.publish.failed', err, payload: event }, 'amqp.publish.failed');
    }
  }
}
