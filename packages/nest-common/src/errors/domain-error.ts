/**
 * Contrato "duck-typed" de los errores de dominio. El dominio de cada servicio es TS puro y no
 * puede importar este paquete (regla domain-is-pure), así que define su propia clase con estas
 * dos propiedades y el filtro HTTP la reconoce por forma, no por herencia.
 *
 *   class DomainError extends Error {
 *     constructor(readonly code: string, readonly kind: DomainErrorKind, message: string) { super(message); }
 *   }
 */
export const DOMAIN_ERROR_KINDS = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'unprocessable',
  'unavailable',
] as const;

export type DomainErrorKind = (typeof DOMAIN_ERROR_KINDS)[number];

export interface DomainErrorLike {
  code: string;
  kind: DomainErrorKind;
  message: string;
  retryAfterSeconds?: number;
}

const STATUS_BY_KIND: Record<DomainErrorKind, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  unavailable: 503,
};

export function isDomainErrorLike(error: unknown): error is DomainErrorLike {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<DomainErrorLike>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.kind === 'string' &&
    (DOMAIN_ERROR_KINDS as readonly string[]).includes(candidate.kind)
  );
}

export function statusForKind(kind: DomainErrorKind): number {
  return STATUS_BY_KIND[kind];
}
