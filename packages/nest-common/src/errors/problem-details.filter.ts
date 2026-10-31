import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { CORRELATION_HEADER, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@toka/contracts';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { isDomainErrorLike, statusForKind } from './domain-error';

const TITLES: Record<number, string> = {
  400: 'Solicitud inválida',
  401: 'No autenticado',
  403: 'Sin permiso',
  404: 'No encontrado',
  405: 'Método no permitido',
  409: 'Conflicto',
  413: 'Solicitud demasiado grande',
  415: 'Tipo de contenido no soportado',
  422: 'No procesable',
  429: 'Demasiadas solicitudes',
  500: 'Error interno',
  502: 'Error en un servicio dependiente',
  503: 'Servicio no disponible',
  504: 'Tiempo de espera agotado',
};

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/** Extensiones que guards y servicios pueden poner en el cuerpo de una HttpException. */
interface HttpExceptionBody {
  code?: string;
  message?: string | string[];
  fieldErrors?: Record<string, string[]>;
  wwwAuthenticate?: string;
  retryAfterSeconds?: number;
}

interface Normalized {
  status: number;
  code: string;
  detail?: string;
  fieldErrors?: Record<string, string[]>;
  headers: Record<string, string>;
}

type HttpRequest = { originalUrl?: string; url?: string; headers: Record<string, unknown> };
type HttpResponse = {
  headersSent?: boolean;
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  type(value: string): HttpResponse;
  send(body: string): void;
};

/**
 * Todas las respuestas de error salen como application/problem+json (RFC 9457) con un `code`
 * estable y el correlationId. Un 5xx nunca expone el mensaje interno: se registra con stack y
 * el cliente recibe un texto genérico más el correlationId para reportarlo.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(ProblemDetailsFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<HttpRequest>();
    const res = ctx.getResponse<HttpResponse>();
    const n = this.normalize(exception);
    const correlationId = typeof req.headers[CORRELATION_HEADER] === 'string' ? (req.headers[CORRELATION_HEADER] as string) : undefined;

    if (n.status >= 500) {
      this.logger.error({ err: exception, code: n.code, status: n.status }, 'request.failed');
    }

    const body: ProblemDetails = {
      type: `urn:toka:problem:${n.code.toLowerCase()}`,
      title: TITLES[n.status] ?? 'Error',
      status: n.status,
      code: n.code,
      ...(n.detail ? { detail: n.detail } : {}),
      instance: (req.originalUrl ?? req.url ?? '').split('?')[0],
      ...(correlationId ? { correlationId } : {}),
      ...(n.fieldErrors ? { fieldErrors: n.fieldErrors } : {}),
    };
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(n.headers)) res.setHeader(name, value);
    res.status(n.status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
  }

  private normalize(exception: unknown): Normalized {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const body: HttpExceptionBody = typeof raw === 'object' && raw !== null ? (raw as HttpExceptionBody) : { message: String(raw) };
      const headers: Record<string, string> = {};
      if (body.wwwAuthenticate) headers['WWW-Authenticate'] = body.wwwAuthenticate;
      if (body.retryAfterSeconds) headers['Retry-After'] = String(Math.ceil(body.retryAfterSeconds));
      const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
      return {
        status,
        code: body.code ?? DEFAULT_CODES[status] ?? `HTTP_${status}`,
        detail: status < 500 ? message : undefined,
        fieldErrors: body.fieldErrors,
        headers,
      };
    }
    if (isDomainErrorLike(exception)) {
      const status = statusForKind(exception.kind);
      const headers: Record<string, string> = {};
      if (exception.retryAfterSeconds) headers['Retry-After'] = String(Math.ceil(exception.retryAfterSeconds));
      return { status, code: exception.code, detail: status < 500 ? exception.message : undefined, headers };
    }
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Ocurrió un error inesperado. Comparte el correlationId para rastrearlo.',
      headers: {},
    };
  }
}
