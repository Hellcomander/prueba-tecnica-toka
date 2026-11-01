/**
 * Error de negocio. `kind` decide el status HTTP (lo traduce el filtro de nest-common, que lo
 * reconoce por forma) y `code` es el identificador estable que ve el cliente.
 * `retryAfterSeconds` lo usa el filtro para la cabecera Retry-After de los 429 y 503: es lo que
 * permite a la SPA mostrar una cuenta regresiva en vez de un "intenta más tarde".
 */
export type DomainErrorKind = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'unprocessable' | 'unavailable';

export class DomainError extends Error {
  override readonly name = 'DomainError';
  constructor(
    readonly code: string,
    readonly kind: DomainErrorKind,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
