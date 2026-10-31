/** Cuerpo de error según RFC 9457 (Problem Details), con extensiones propias. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Código estable para el cliente (p. ej. LAST_ADMIN, VERSION_CONFLICT). */
  code: string;
  correlationId?: string;
  /** Errores de validación por campo (solo en 400). */
  fieldErrors?: Record<string, string[]>;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
