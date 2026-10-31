import { EVENTS } from './events/catalog';

/**
 * Topología de RabbitMQ, definida en un solo lugar. Cada servicio la declara al arrancar
 * (las declaraciones son idempotentes), así que no importa cuál arranque primero.
 *
 *   toka.events (topic) ──binding──▶ <cola>          consumidor normal
 *   <cola>.retry  (sin consumidor, TTL 5 s) ──expira──▶ <cola>     reintento diferido
 *   toka.dlx (direct) ──routing key = <cola>──▶ <cola>.dlq   mensajes muertos
 */
export const EVENTS_EXCHANGE = 'toka.events';
export const DEAD_LETTER_EXCHANGE = 'toka.dlx';
export const RETRY_DELAY_MS = 5_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const ATTEMPT_HEADER = 'x-attempt';
export const CORRELATION_HEADER = 'x-correlation-id';

export interface QueueDefinition {
  name: string;
  bindings: readonly string[];
}

export const retryQueueName = (queue: string): string => `${queue}.retry`;
export const deadLetterQueueName = (queue: string): string => `${queue}.dlq`;

export const QUEUES = {
  audit: { name: 'audit-service.all', bindings: ['#'] },
  user: {
    name: 'user-service.events',
    bindings: [EVENTS.ACCOUNT_REGISTERED, EVENTS.ROLE_ASSIGNMENTS_CHANGED],
  },
  role: {
    name: 'role-service.events',
    bindings: [EVENTS.ACCOUNT_REGISTERED, EVENTS.USER_STATUS_CHANGED],
  },
  auth: { name: 'auth-service.events', bindings: [EVENTS.USER_STATUS_CHANGED] },
} as const satisfies Record<string, QueueDefinition>;
