import { DomainError } from '../shared/domain-error';

export type RevocationReason = 'logout' | 'refresh_reuse' | 'user_suspended' | 'password_changed';

export interface SessionProps {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevocationReason | null;
}

/**
 * Sesión = familia de refresh tokens. Rotar produce un token nuevo dentro de la MISMA sesión, así
 * que revocar la sesión mata a toda la familia de una vez (es lo que se hace al detectar reúso).
 * `expiresAt` es el tope absoluto: aunque el usuario renueve sin parar, la sesión caduca.
 */
export class Session {
  private constructor(
    readonly id: string,
    readonly userId: string,
    readonly createdAt: Date,
    readonly expiresAt: Date,
    private _revokedAt: Date | null,
    private _revokedReason: RevocationReason | null,
  ) {}

  static start(input: { id: string; userId: string; now: Date; lifetimeMs: number }): Session {
    return new Session(input.id, input.userId, input.now, new Date(input.now.getTime() + input.lifetimeMs), null, null);
  }

  static restore(props: SessionProps): Session {
    return new Session(props.id, props.userId, props.createdAt, props.expiresAt, props.revokedAt, props.revokedReason);
  }

  get revokedAt(): Date | null {
    return this._revokedAt;
  }
  get revokedReason(): RevocationReason | null {
    return this._revokedReason;
  }
  get isRevoked(): boolean {
    return this._revokedAt !== null;
  }

  isActive(now: Date): boolean {
    return !this.isRevoked && this.expiresAt.getTime() > now.getTime();
  }

  /** Idempotente: revocar dos veces conserva el motivo original (el primero es el que explica). */
  revoke(reason: RevocationReason, now: Date): boolean {
    if (this.isRevoked) return false;
    this._revokedAt = now;
    this._revokedReason = reason;
    return true;
  }
}

export interface RefreshTokenProps {
  tokenHash: string;
  sessionId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Refresh token: en base solo vive su SHA-256. Quien lea la base no puede renovar sesiones con lo
 * que ve, y el token en claro solo existe en la cookie del cliente.
 */
export class RefreshToken {
  private constructor(
    readonly tokenHash: string,
    readonly sessionId: string,
    readonly expiresAt: Date,
    private readonly _usedAt: Date | null,
  ) {}

  static issue(input: { tokenHash: string; sessionId: string; now: Date; lifetimeMs: number }): RefreshToken {
    return new RefreshToken(input.tokenHash, input.sessionId, new Date(input.now.getTime() + input.lifetimeMs), null);
  }

  static restore(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props.tokenHash, props.sessionId, props.expiresAt, props.usedAt);
  }

  get usedAt(): Date | null {
    return this._usedAt;
  }
  get isUsed(): boolean {
    return this._usedAt !== null;
  }

  isExpired(now: Date): boolean {
    return this.expiresAt.getTime() <= now.getTime();
  }
}

export type RefreshDecision =
  | { kind: 'rotate' }
  /** El token ya se había rotado: alguien lo reusó, hay que matar la familia entera. */
  | { kind: 'reuse' }
  | { kind: 'reject'; reason: 'unknown' | 'token_expired' | 'session_revoked' | 'session_expired' };

/**
 * Regla de rotación, pura y por lo tanto fácil de probar. El orden importa: un token YA USADO se
 * trata como robo aunque además esté vencido o la sesión revocada, porque esa señal es la que
 * dispara la revocación de la familia.
 */
export function decideRefresh(found: { session: Session; token: RefreshToken } | null, now: Date): RefreshDecision {
  if (!found) return { kind: 'reject', reason: 'unknown' };
  const { session, token } = found;
  if (token.isUsed) return { kind: 'reuse' };
  if (session.isRevoked) return { kind: 'reject', reason: 'session_revoked' };
  if (token.isExpired(now)) return { kind: 'reject', reason: 'token_expired' };
  if (!session.isActive(now)) return { kind: 'reject', reason: 'session_expired' };
  return { kind: 'rotate' };
}

/**
 * El cliente nunca sabe POR QUÉ falló la renovación (token desconocido, vencido o reusado): todos
 * los caminos devuelven el mismo 401, para no darle información al atacante.
 */
export const invalidRefreshError = (): DomainError =>
  new DomainError('INVALID_REFRESH_TOKEN', 'unauthorized', 'La sesión expiró o el token de renovación no es válido');
