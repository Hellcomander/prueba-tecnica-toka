import { ATTEMPT_HEADER, createEnvelope, EVENTS, parseEvent } from '@toka/contracts';
import {
  type AckChannel,
  type AmqpMessageLike,
  applyOutcome,
  attemptOf,
  decideFailureAction,
  NonRetryableError,
  processMessage,
} from './message-processing';

const USER_ID = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';
const QUEUE = 'role-service.events';

const event = () =>
  createEnvelope({
    type: EVENTS.ACCOUNT_REGISTERED,
    producer: 'auth-service',
    correlationId: 'corr-abcdef12',
    subject: { type: 'user', id: USER_ID },
    data: { userId: USER_ID, email: 'ana@toka.test', fullName: 'Ana', source: 'admin' as const },
  });

const message = (body: unknown, attempt?: number): AmqpMessageLike => ({
  content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  properties: { headers: attempt ? { [ATTEMPT_HEADER]: attempt, 'x-correlation-id': 'corr-abcdef12' } : {} },
});

/** Canal falso que simula lo que haría RabbitMQ con la topología declarada. */
class FakeChannel implements AckChannel {
  acked: AmqpMessageLike[] = [];
  deadLettered: AmqpMessageLike[] = [];
  retried: { queue: string; message: AmqpMessageLike }[] = [];
  ack(m: AmqpMessageLike) {
    this.acked.push(m);
  }
  nack(m: AmqpMessageLike, _allUpTo?: boolean, requeue?: boolean) {
    if (requeue === false) this.deadLettered.push(m);
  }
  sendToQueue(queue: string, content: Buffer, options?: { headers?: Record<string, unknown> }) {
    this.retried.push({ queue, message: { content, properties: { headers: options?.headers } } });
    return true;
  }
}

const runInContext = async (_ctx: unknown, fn: () => Promise<void>) => fn();
const parse = (raw: unknown) => parseEvent(raw, [EVENTS.ACCOUNT_REGISTERED]);

describe('procesamiento de mensajes con reintento y DLQ', () => {
  it('handler OK → ack, con el contexto del evento (correlationId y causationId = eventId)', async () => {
    const ev = event();
    const contexts: unknown[] = [];
    const outcome = await processMessage(message(ev), parse, async () => undefined, async (ctx, fn) => {
      contexts.push(ctx);
      await fn();
    });
    expect(outcome).toEqual({ action: 'ack', eventId: ev.eventId, type: EVENTS.ACCOUNT_REGISTERED });
    expect(contexts).toEqual([{ correlationId: 'corr-abcdef12', causationId: ev.eventId }]);
  });

  it('un mensaje que falla siempre va a .retry con x-attempt creciente y, al tercer intento, a la DLQ', async () => {
    const channel = new FakeChannel();
    const failing = async () => {
      throw new Error('base de datos caída');
    };

    let current = message(event());
    for (let delivery = 1; delivery <= 3; delivery++) {
      const outcome = await processMessage(current, parse, failing, runInContext);
      applyOutcome(channel, QUEUE, current, outcome);
      if (delivery < 3) {
        expect(outcome).toMatchObject({ action: 'retry', nextAttempt: delivery + 1 });
        const retried = channel.retried.at(-1)!;
        expect(retried.queue).toBe(`${QUEUE}.retry`);
        expect(retried.message.properties.headers?.[ATTEMPT_HEADER]).toBe(delivery + 1);
        // Al expirar el TTL, RabbitMQ devuelve el mensaje a la cola original: simulamos la entrega.
        current = retried.message;
      } else {
        expect(outcome).toMatchObject({ action: 'dead-letter', attempt: 3 });
      }
    }
    expect(channel.retried).toHaveLength(2);
    expect(channel.acked).toHaveLength(2);
    expect(channel.deadLettered).toHaveLength(1);
  });

  it('JSON roto, schema inválido o NonRetryableError van directo a la DLQ (reintentar no ayuda)', async () => {
    const ok = async () => undefined;
    expect((await processMessage(message('{no-json'), parse, ok, runInContext)).action).toBe('dead-letter');
    expect((await processMessage(message({ ...event(), data: { userId: 'x' } }), parse, ok, runInContext)).action).toBe('dead-letter');
    const rule = async () => {
      throw new NonRetryableError('regla de negocio');
    };
    expect(await processMessage(message(event()), parse, rule, runInContext)).toMatchObject({ action: 'dead-letter', attempt: 1 });
  });

  it('attemptOf y decideFailureAction', () => {
    expect(attemptOf(message({}, 2))).toBe(2);
    expect(attemptOf(message({}))).toBe(1);
    expect(attemptOf({ content: Buffer.from(''), properties: { headers: { [ATTEMPT_HEADER]: 'basura' } } })).toBe(1);
    expect(decideFailureAction(new Error('x'), 1)).toBe('retry');
    expect(decideFailureAction(new Error('x'), 3)).toBe('dead-letter');
    expect(decideFailureAction(new SyntaxError('x'), 1)).toBe('dead-letter');
  });

  it('applyOutcome ack confirma sin republicar', () => {
    const channel = new FakeChannel();
    const m = message(event());
    applyOutcome(channel, QUEUE, m, { action: 'ack', eventId: 'e', type: 't' });
    expect(channel.acked).toEqual([m]);
    expect(channel.retried).toHaveLength(0);
  });
});
