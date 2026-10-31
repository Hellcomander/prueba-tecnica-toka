import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER } from '@toka/contracts';
import { ClsServiceManager } from 'nestjs-cls';

export const CLS_CORRELATION_ID = 'correlationId';
export const CLS_CAUSATION_ID = 'causationId';
export const CLS_USER_ID = 'userId';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Solo se acepta un correlation-id entrante con formato seguro (evita inyección en logs). */
export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_PATTERN.test(value);
}

export function resolveCorrelationId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return isValidCorrelationId(value) ? value : randomUUID();
}

/**
 * Primer middleware de la app: fija el correlation-id en el request (lo leen CLS y pino-http)
 * y lo devuelve en la respuesta para que el cliente pueda reportarlo.
 */
export function correlationMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const id = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
  req.headers[CORRELATION_HEADER] = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}

function activeStore(): { get(key: string): unknown } | null {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive() ? cls : null;
}

export function currentCorrelationId(): string | undefined {
  return activeStore()?.get(CLS_CORRELATION_ID) as string | undefined;
}

/** Campos de contexto para cada línea de log emitida dentro de un request o mensaje. */
export function contextLogFields(): Record<string, unknown> {
  const store = activeStore();
  if (!store) return {};
  const fields: Record<string, unknown> = {};
  for (const key of [CLS_CORRELATION_ID, CLS_CAUSATION_ID, CLS_USER_ID]) {
    const value = store.get(key);
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}
