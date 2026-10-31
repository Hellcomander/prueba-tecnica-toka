import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER } from '@toka/contracts';
import pino, { type LoggerOptions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import { contextLogFields } from '../context/request-context';

/** Rutas que pino reemplaza por "[Redacted]" antes de escribir: credenciales y tokens nunca llegan al log. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'token',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.refreshToken',
  '*.accessToken',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.client_secret',
  '*.authorization',
];

export interface LoggerConfig {
  service: string;
  level?: string;
  version?: string;
}

export function buildLoggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level ?? 'info',
    base: { service: config.service, env: process.env.NODE_ENV ?? 'development', version: config.version ?? '0.1.0' },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    // Las líneas de acceso HTTP ya traen correlationId/userId por customProps; el resto los toma del CLS.
    mixin: (mergeObject) => ('res' in mergeObject ? {} : contextLogFields()),
  };
}

export function buildPinoHttpOptions(config: LoggerConfig): PinoHttpOptions<IncomingMessage, ServerResponse> {
  return {
    ...buildLoggerOptions(config),
    genReqId: (req) => (req.headers[CORRELATION_HEADER] as string | undefined) ?? randomUUID(),
    customProps: (req) => ({ correlationId: req.id, userId: (req as IncomingMessage & { user?: { id?: string } }).user?.id }),
    autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    serializers: {
      req: (req: { id?: unknown; method?: string; url?: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}
