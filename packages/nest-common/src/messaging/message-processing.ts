import { ATTEMPT_HEADER, InvalidEventError, MAX_DELIVERY_ATTEMPTS, retryQueueName } from '@toka/contracts';

/** Error que reintentar no arregla (p. ej. un evento que viola una regla de negocio): va directo a la DLQ. */
export class NonRetryableError extends Error {
  override readonly name = 'NonRetryableError';
}

export interface AmqpMessageLike {
  content: Buffer;
  properties: { headers?: Record<string, unknown> };
}

/** Subconjunto del canal de amqplib que necesita la lógica de reintento (fácil de simular en tests). */
export interface AckChannel<M extends AmqpMessageLike = AmqpMessageLike> {
  ack(message: M): void;
  nack(message: M, allUpTo?: boolean, requeue?: boolean): void;
  sendToQueue(queue: string, content: Buffer, options?: object): boolean;
}

export type MessageOutcome =
  | { action: 'ack'; eventId: string; type: string }
  | { action: 'retry'; nextAttempt: number; error: unknown; eventId?: string; type?: string }
  | { action: 'dead-letter'; attempt: number; error: unknown; eventId?: string; type?: string };

export interface MessageContext {
  correlationId: string;
  causationId: string;
}

export function attemptOf(message: AmqpMessageLike): number {
  const n = Number(message.properties.headers?.[ATTEMPT_HEADER]);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** JSON roto, schema inválido o NonRetryableError → DLQ de inmediato; el resto se reintenta hasta el máximo. */
export function decideFailureAction(error: unknown, attempt: number, maxAttempts = MAX_DELIVERY_ATTEMPTS): 'retry' | 'dead-letter' {
  if (error instanceof SyntaxError || error instanceof InvalidEventError || error instanceof NonRetryableError) {
    return 'dead-letter';
  }
  return attempt >= maxAttempts ? 'dead-letter' : 'retry';
}

/**
 * Procesa un mensaje: parsea, valida, ejecuta el handler dentro del contexto del evento
 * (correlationId y causationId = eventId, para que los logs y los eventos que emita el handler
 * queden encadenados) y decide qué hacer con el mensaje.
 */
export async function processMessage<TEvent extends { eventId: string; type: string; correlationId: string }>(
  message: AmqpMessageLike,
  parse: (raw: unknown) => TEvent,
  handler: (event: TEvent) => Promise<void>,
  runInContext: (ctx: MessageContext, fn: () => Promise<void>) => Promise<void>,
): Promise<MessageOutcome> {
  const attempt = attemptOf(message);
  let event: TEvent | undefined;
  try {
    event = parse(JSON.parse(message.content.toString('utf8')));
    const parsed = event;
    await runInContext({ correlationId: parsed.correlationId, causationId: parsed.eventId }, () => handler(parsed));
    return { action: 'ack', eventId: parsed.eventId, type: parsed.type };
  } catch (error) {
    const ids = event ? { eventId: event.eventId, type: event.type } : {};
    return decideFailureAction(error, attempt) === 'retry'
      ? { action: 'retry', nextAttempt: attempt + 1, error, ...ids }
      : { action: 'dead-letter', attempt, error, ...ids };
  }
}

/**
 * retry: copia el mensaje a <cola>.retry (TTL 5 s, sin consumidor; al expirar vuelve a la cola
 * original) con x-attempt+1 y confirma el original. dead-letter: nack sin requeue → toka.dlx →
 * <cola>.dlq. Primero se publica la copia y después se confirma: ante una caída en medio puede
 * haber un duplicado, nunca una pérdida (por eso los consumidores son idempotentes).
 */
export function applyOutcome<M extends AmqpMessageLike>(channel: AckChannel<M>, queue: string, message: M, outcome: MessageOutcome): void {
  switch (outcome.action) {
    case 'ack':
      channel.ack(message);
      return;
    case 'retry':
      channel.sendToQueue(retryQueueName(queue), message.content, {
        ...message.properties,
        persistent: true,
        headers: { ...(message.properties.headers ?? {}), [ATTEMPT_HEADER]: outcome.nextAttempt },
      });
      channel.ack(message);
      return;
    case 'dead-letter':
      channel.nack(message, false, false);
      return;
  }
}
