import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ValidationError } from '@nestjs/common';
import { EVENTS } from '@toka/contracts';
import { ClsServiceManager } from 'nestjs-cls';
import { z } from 'zod';
import { DedupWindow } from './auth/guards';
import { amqpEnvSchema, authEnvSchema, baseEnvSchema, EnvValidationError, parseEnv, redisEnvSchema } from './config/env';
import {
  CLS_CAUSATION_ID,
  CLS_CORRELATION_ID,
  contextLogFields,
  correlationMiddleware,
  currentCorrelationId,
  isValidCorrelationId,
  resolveCorrelationId,
} from './context/request-context';
import { isDomainErrorLike, statusForKind } from './errors/domain-error';
import { type EventPublisher, IntegrationEventFactory } from './messaging/event-publisher';
import { EventPublishingSecurityEventSink } from './messaging/messaging.module';
import { flattenValidationErrors } from './validation/validation.pipe';

describe('parseEnv', () => {
  const schema = baseEnvSchema.extend(authEnvSchema.shape).extend(amqpEnvSchema.shape).extend(redisEnvSchema.shape);

  it('aplica defaults y convierte tipos', () => {
    const env = parseEnv(schema, {
      PORT: '3003',
      OIDC_ISSUER: 'http://auth-service:3001',
      RABBITMQ_URL: 'amqp://u:p@rabbitmq:5672',
      REDIS_URL: 'redis://:p@redis:6379',
    });
    expect(env).toMatchObject({ PORT: 3003, NODE_ENV: 'development', LOG_LEVEL: 'info', TRUST_PROXY_HOPS: 1, AUTH_AUDIENCE: 'toka-api' });
  });

  it('falla al arrancar con un mensaje que nombra cada variable inválida', () => {
    expect(() => parseEnv(schema, { PORT: 'abc', OIDC_ISSUER: 'no-url', RABBITMQ_URL: 'http://x', REDIS_URL: 'x' })).toThrow(EnvValidationError);
    try {
      parseEnv(schema, { PORT: 'abc' });
    } catch (e) {
      for (const name of ['PORT', 'OIDC_ISSUER', 'RABBITMQ_URL', 'REDIS_URL']) expect((e as Error).message).toContain(name);
    }
    expect(parseEnv(z.object({ A: z.string() }), { A: 'x' })).toEqual({ A: 'x' });
  });
});

describe('correlation-id y contexto', () => {
  it('solo acepta ids con formato seguro; si no, genera uno', () => {
    expect(isValidCorrelationId('abc-12345')).toBe(true);
    expect(isValidCorrelationId('corto')).toBe(false);
    expect(isValidCorrelationId('x'.repeat(65))).toBe(false);
    expect(isValidCorrelationId('inyección\n{"level":"fatal"}')).toBe(false);
    expect(resolveCorrelationId(['abc-12345', 'otro-123456'])).toBe('abc-12345');
    expect(resolveCorrelationId('mal formato!')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('el middleware fija el header en el request y lo devuelve en la respuesta', () => {
    const req = { headers: {} } as IncomingMessage;
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as ServerResponse;
    const next = jest.fn();
    correlationMiddleware(req, res, next);
    expect(req.headers['x-correlation-id']).toBe(headers['X-Correlation-Id']);
    expect(next).toHaveBeenCalled();
  });

  it('contextLogFields y currentCorrelationId leen el CLS solo cuando está activo', () => {
    expect(contextLogFields()).toEqual({});
    expect(currentCorrelationId()).toBeUndefined();
    const cls = ClsServiceManager.getClsService();
    cls.run(() => {
      cls.set(CLS_CORRELATION_ID, 'corr-12345678');
      cls.set(CLS_CAUSATION_ID, 'evt-1');
      expect(contextLogFields()).toEqual({ correlationId: 'corr-12345678', causationId: 'evt-1' });
      expect(currentCorrelationId()).toBe('corr-12345678');
    });
  });
});

describe('errores de dominio', () => {
  class DomainError extends Error {
    constructor(
      readonly code: string,
      readonly kind: string,
      message: string,
    ) {
      super(message);
    }
  }
  it('se reconocen por forma, no por herencia', () => {
    expect(isDomainErrorLike(new DomainError('LAST_ADMIN', 'conflict', 'x'))).toBe(true);
    expect(isDomainErrorLike(new DomainError('X', 'otra-cosa', 'x'))).toBe(false);
    expect(isDomainErrorLike({ code: 'X', kind: 'conflict' })).toBe(false);
    expect(statusForKind('conflict')).toBe(409);
    expect(statusForKind('not_found')).toBe(404);
  });
});

describe('flattenValidationErrors', () => {
  it('aplana errores anidados con rutas punteadas', () => {
    const errors = [
      { property: 'email', constraints: { isEmail: 'email inválido' }, children: [] },
      { property: 'address', children: [{ property: 'zip', constraints: { length: 'zip de 5 dígitos' }, children: [] }] },
    ] as unknown as ValidationError[];
    expect(flattenValidationErrors(errors)).toEqual({ email: ['email inválido'], 'address.zip': ['zip de 5 dígitos'] });
  });
});

describe('DedupWindow', () => {
  it('emite una vez por clave dentro de la ventana y limpia entradas viejas', () => {
    let now = 0;
    const window = new DedupWindow(1_000, () => now);
    expect(window.shouldEmit('a')).toBe(true);
    expect(window.shouldEmit('a')).toBe(false);
    now = 1_500;
    expect(window.shouldEmit('a')).toBe(true);
    for (let i = 0; i < 10_001; i++) window.shouldEmit(`k${i}`);
    now = 5_000;
    expect(window.shouldEmit('nueva')).toBe(true);
  });
});

describe('IntegrationEventFactory y sink de seguridad', () => {
  const USER_ID = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';
  const cls = ClsServiceManager.getClsService();
  const factory = new IntegrationEventFactory('role-service', cls);

  it('toma correlationId y causationId del contexto activo', () => {
    const ev = cls.run(() => {
      cls.set(CLS_CORRELATION_ID, 'corr-12345678');
      cls.set(CLS_CAUSATION_ID, 'evt-padre');
      return factory.create(EVENTS.ROLE_DELETED, { subject: { type: 'role', id: USER_ID }, data: { roleId: USER_ID, name: 'x' } });
    });
    expect(ev).toMatchObject({ producer: 'role-service', correlationId: 'corr-12345678', causationId: 'evt-padre', type: 'role.deleted' });
  });

  it('fuera de contexto genera un correlationId nuevo y sin causación', () => {
    const ev = factory.create(EVENTS.ROLE_DELETED, { subject: { type: 'role', id: USER_ID }, data: { roleId: USER_ID, name: 'x' } });
    expect(ev.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev.causationId).toBeNull();
  });

  it('publica access.denied con actor y ruta', async () => {
    const published: unknown[] = [];
    const publisher: EventPublisher = { publish: async (e) => void published.push(e) };
    const sink = new EventPublishingSecurityEventSink(publisher, factory);
    await sink.accessDenied({ userId: USER_ID, method: 'GET', route: '/api/v1/audit/events', required: ['audit:read'], reason: 'missing_permission' });
    await sink.accessDenied({ userId: 'service:x', method: 'GET', route: '/api/v1/users', required: ['users:read'], reason: 'wrong_token_use' });
    expect(published[0]).toMatchObject({
      type: 'access.denied',
      subject: { type: 'route', id: 'GET /api/v1/audit/events' },
      actor: { id: USER_ID, type: 'user' },
      data: { required: ['audit:read'] },
    });
    expect(published[1]).toMatchObject({ actor: { type: 'service' } });
  });
});
