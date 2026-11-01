/**
 * Error de negocio. `kind` decide el status HTTP (lo traduce el filtro de nest-common, que lo
 * reconoce por forma) y `code` es el identificador estable que ve el cliente.
 */
export type DomainErrorKind = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'unprocessable' | 'unavailable';

export class DomainError extends Error {
  override readonly name = 'DomainError';
  constructor(
    readonly code: string,
    readonly kind: DomainErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Lockout por fuerza bruta. No es un DomainError normal porque su status (429) no está en la
 * tabla de `kind`s: lo traduce `LockoutInterceptor` en la capa HTTP, que además pone Retry-After.
 * Declara `kind: 'forbidden'` como red de seguridad: si algún día escapa sin pasar por el
 * interceptor, el cliente verá 403, nunca un 500 con detalles internos.
 */
export class TooManyAttemptsError extends Error {
  override readonly name = 'TooManyAttemptsError';
  readonly code = 'TOO_MANY_ATTEMPTS';
  readonly kind: DomainErrorKind = 'forbidden';
  constructor(readonly retryAfterSeconds: number) {
    super('Demasiados intentos fallidos. Espera unos minutos antes de volver a intentar');
  }
}
