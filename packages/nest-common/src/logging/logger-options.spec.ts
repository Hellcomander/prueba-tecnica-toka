import type { IncomingMessage, ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { ClsServiceManager } from 'nestjs-cls';
import pino from 'pino';
import { CLS_CORRELATION_ID, CLS_USER_ID } from '../context/request-context';
import { buildLoggerOptions, buildPinoHttpOptions } from './logger-options';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, logger: pino(buildLoggerOptions({ service: 'test-svc', level: 'info' }), stream) };
}

describe('opciones de logging', () => {
  it('escribe JSON con service, level como texto y tiempo ISO', () => {
    const { lines, logger } = capture();
    logger.info({ event: 'x' }, 'hola');
    expect(lines[0]).toMatchObject({ service: 'test-svc', level: 'info', msg: 'hola', event: 'x' });
    expect(typeof lines[0].time).toBe('string');
  });

  it('redacta credenciales y tokens antes de escribir', () => {
    const { lines, logger } = capture();
    logger.info({
      password: 'p1',
      body: { password: 'p2', newPassword: 'p3', refreshToken: 'r', accessToken: 'a', apiKey: 'k', clientSecret: 's' },
      req: { headers: { authorization: 'Bearer abc', cookie: 'toka_rt=x' } },
    });
    const out = JSON.stringify(lines[0]);
    for (const secret of ['p1', 'p2', 'p3', '"r"', '"a"', '"k"', '"s"', 'Bearer abc', 'toka_rt=x']) expect(out).not.toContain(secret);
    expect(out).toContain('[Redacted]');
  });

  it('agrega correlationId y userId del contexto, salvo en la línea de acceso HTTP', () => {
    const { lines, logger } = capture();
    const cls = ClsServiceManager.getClsService();
    cls.run(() => {
      cls.set(CLS_CORRELATION_ID, 'corr-12345678');
      cls.set(CLS_USER_ID, 'u-1');
      logger.info('dentro');
      logger.info({ res: { statusCode: 200 } }, 'acceso');
    });
    logger.info('fuera');
    expect(lines[0]).toMatchObject({ correlationId: 'corr-12345678', userId: 'u-1' });
    expect(lines[1].correlationId).toBeUndefined();
    expect(lines[2].correlationId).toBeUndefined();
  });

  it('pino-http: id = correlation-id, nivel por status, ignora /health y serializa lo mínimo', () => {
    const opts = buildPinoHttpOptions({ service: 's' });
    const req = { headers: { 'x-correlation-id': 'corr-12345678' }, url: '/api/v1/users', method: 'GET' } as unknown as IncomingMessage;
    const res = (statusCode: number) => ({ statusCode }) as ServerResponse;
    expect(opts.genReqId!(req, res(200))).toBe('corr-12345678');
    expect(opts.genReqId!({ headers: {} } as IncomingMessage, res(200))).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts.customLogLevel!(req, res(200), undefined)).toBe('info');
    expect(opts.customLogLevel!(req, res(404), undefined)).toBe('warn');
    expect(opts.customLogLevel!(req, res(503), undefined)).toBe('error');
    expect(opts.customLogLevel!(req, res(200), new Error('x'))).toBe('error');
    const ignore = (opts.autoLogging as { ignore: (r: IncomingMessage) => boolean }).ignore;
    expect(ignore({ url: '/health/ready' } as IncomingMessage)).toBe(true);
    expect(ignore(req)).toBe(false);
    expect(ignore({} as IncomingMessage)).toBe(false);
    expect(opts.customProps!(Object.assign(req, { id: 'corr-12345678', user: { id: 'u-9' } }), res(200))).toEqual({ correlationId: 'corr-12345678', userId: 'u-9' });
    expect(opts.customSuccessMessage!(req, res(200), 1)).toBe('GET /api/v1/users 200');
    expect(opts.customErrorMessage!(req, res(500), new Error('x'))).toBe('GET /api/v1/users 500');
    const serializers = opts.serializers as Record<string, (v: unknown) => unknown>;
    expect(serializers.req({ id: 'a', method: 'GET', url: '/x', headers: { authorization: 'x' } })).toEqual({ id: 'a', method: 'GET', url: '/x' });
    expect(serializers.res({ statusCode: 201, headers: {} })).toEqual({ statusCode: 201 });
  });
});
