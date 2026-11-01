/**
 * Error de negocio. `kind` decide el status HTTP (lo traduce el filtro de nest-common, que lo
 * reconoce por forma) y `code` es el identificador estable que ve el cliente.
 */
export type DomainErrorKind = 'validation' | 'not_found' | 'conflict' | 'forbidden' | 'unprocessable';

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
