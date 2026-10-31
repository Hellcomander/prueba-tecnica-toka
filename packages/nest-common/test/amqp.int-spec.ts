import 'reflect-metadata';
import { createEnvelope, EVENTS_EXCHANGE, parseEnvelope, type QueueDefinition } from '@toka/contracts';
import * as amqplib from 'amqplib';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { CLS_CORRELATION_ID, currentCorrelationId } from '../src/context/request-context';
import { AmqpConnection } from '../src/infrastructure/messaging/amqp-connection';

/**
 * Prueba de integración contra un RabbitMQ real (docker compose + docker-compose.dev.yml):
 *   RABBITMQ_URL=amqp://toka:rabbit_dev_pw@127.0.0.1:15673 npm run test:int -w packages/nest-common
 * Verifica la topología completa: cola → .retry (TTL) → cola → … → .dlq.
 */
const url = process.env.RABBITMQ_URL;
const describeIfBroker = url ? describe : describe.skip;

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as PinoLogger;

describeIfBroker('AmqpConnection contra RabbitMQ real', () => {
  const suffix = Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, 'x');
  const routingKey = `itest.message_${suffix}`;
  const queue: QueueDefinition = { name: `itest-${suffix}`, bindings: [routingKey] };
  let connection: AmqpConnection;
  let admin: amqplib.ChannelModel;
  let adminChannel: amqplib.Channel;

  beforeAll(async () => {
    connection = new AmqpConnection({ url: url!, queues: [] }, silentLogger, ClsServiceManager.getClsService());
    connection.onModuleInit();
    admin = await amqplib.connect(url!);
    adminChannel = await admin.createChannel();
  });

  afterAll(async () => {
    await connection.onApplicationShutdown();
    for (const q of [queue.name, `${queue.name}.retry`, `${queue.name}.dlq`]) await adminChannel.deleteQueue(q).catch(() => undefined);
    await admin.close();
  });

  it('un mensaje que siempre falla pasa por .retry dos veces y termina en .dlq; el handler corre con el correlationId', async () => {
    const deliveries: { at: number; correlationId?: string }[] = [];
    await connection.consume(queue, parseEnvelope, async () => {
      deliveries.push({ at: Date.now(), correlationId: currentCorrelationId() });
      throw new Error('falla simulada');
    });
    await connection.waitUntilReady();

    const event = createEnvelope({
      type: routingKey,
      producer: 'itest',
      correlationId: 'itest-corr-1234',
      subject: { type: 'test', id: '1' },
      data: { hello: 'world' },
    });
    expect(connection.isConnected()).toBe(true);
    await connection.publish(event);

    const deadline = Date.now() + 25_000;
    let dlq = 0;
    while (Date.now() < deadline) {
      dlq = (await adminChannel.checkQueue(`${queue.name}.dlq`)).messageCount;
      if (dlq === 1) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(dlq).toBe(1);
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.correlationId === 'itest-corr-1234')).toBe(true);
    // El reintento es diferido: entre entregas pasa el TTL de la cola .retry (5 s).
    expect(deliveries[1].at - deliveries[0].at).toBeGreaterThanOrEqual(4_500);
    expect((await adminChannel.checkQueue(queue.name)).messageCount).toBe(0);
    expect((await adminChannel.checkQueue(`${queue.name}.retry`)).messageCount).toBe(0);

    const dead = await adminChannel.get(`${queue.name}.dlq`, { noAck: true });
    expect(dead && JSON.parse(dead.content.toString()).eventId).toBe(event.eventId);
    expect(dead && dead.properties.headers?.['x-attempt']).toBe(3);
    expect(EVENTS_EXCHANGE).toBe('toka.events');
  }, 40_000);

  it('el CLS de un mensaje no se filtra al siguiente', () => {
    const cls = ClsServiceManager.getClsService();
    cls.run(() => cls.set(CLS_CORRELATION_ID, 'x-12345678'));
    expect(currentCorrelationId()).toBeUndefined();
  });
});
