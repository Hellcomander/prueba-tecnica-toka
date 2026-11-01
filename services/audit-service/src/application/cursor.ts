import { InvalidQueryError } from './errors';

export interface CursorPosition {
  occurredAt: Date;
  id: string;
}

/**
 * El cursor es la pareja (occurredAt, _id) de la última fila entregada, la misma que ordena los
 * índices. Es opaco para el cliente (base64url) pero no está firmado: solo puede mover la
 * ventana de lectura, nunca dar acceso a algo que el permiso `audit:read` no cubra.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: position.occurredAt.toISOString(), id: position.id })).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { t, id } = parsed as { t?: unknown; id?: unknown };
      if (typeof t === 'string' && typeof id === 'string' && id.length > 0) {
        const occurredAt = new Date(t);
        if (!Number.isNaN(occurredAt.getTime())) return { occurredAt, id };
      }
    }
  } catch {
    // cae al error de abajo
  }
  throw new InvalidQueryError('INVALID_CURSOR', 'El cursor no es válido');
}
