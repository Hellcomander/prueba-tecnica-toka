import {
  DEAD_LETTER_EXCHANGE,
  deadLetterQueueName,
  EVENTS_EXCHANGE,
  type QueueDefinition,
  RETRY_DELAY_MS,
  retryQueueName,
} from '@toka/contracts';

export interface TopologyChannel {
  assertExchange(name: string, type: string, options: Record<string, unknown>): Promise<unknown>;
  assertQueue(name: string, options: Record<string, unknown>): Promise<unknown>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<unknown>;
}

/**
 * Declara exchanges y colas (idempotente). Ojo: RabbitMQ no permite redeclarar una cola con
 * argumentos distintos (PRECONDITION_FAILED); cambiar TTL o DLX exige borrar la cola antes.
 */
export async function declareTopology(channel: TopologyChannel, queues: readonly QueueDefinition[]): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  for (const queue of queues) {
    await channel.assertQueue(queue.name, {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      deadLetterRoutingKey: queue.name,
    });
    for (const binding of queue.bindings) await channel.bindQueue(queue.name, EVENTS_EXCHANGE, binding);
    // TTL a nivel de cola (no por mensaje): todos expiran en orden y no hay bloqueo de cabeza de fila.
    await channel.assertQueue(retryQueueName(queue.name), {
      durable: true,
      messageTtl: RETRY_DELAY_MS,
      deadLetterExchange: '',
      deadLetterRoutingKey: queue.name,
    });
    await channel.assertQueue(deadLetterQueueName(queue.name), { durable: true });
    await channel.bindQueue(deadLetterQueueName(queue.name), DEAD_LETTER_EXCHANGE, queue.name);
  }
}
