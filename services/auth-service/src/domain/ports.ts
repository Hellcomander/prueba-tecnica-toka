import type { Account } from './account/account';
import type { RefreshToken, RevocationReason, Session } from './session/session';

/**
 * Puertos de persistencia y de criptografía de contraseñas. El dominio define QUÉ necesita;
 * infrastructure implementa CÓMO (Prisma, argon2) y los tests usan equivalentes en memoria.
 */
export interface AccountRepository {
  findById(id: string): Promise<Account | null>;
  /** El email ya viene normalizado por el value object Email. */
  findByEmail(email: string): Promise<Account | null>;
  /** Lanza EMAIL_TAKEN si el email ya existe (único en base). */
  insert(account: Account): Promise<void>;
  /** Lanza VERSION_CONFLICT si la versión en base ya no es account.persistedVersion. */
  update(account: Account): Promise<void>;
}

export interface SessionRepository {
  /** Abre la sesión y emite su primer refresh token, en la misma transacción. */
  start(session: Session, token: RefreshToken): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<{ session: Session; token: RefreshToken } | null>;
  /**
   * Marca el token como usado y devuelve false si OTRO request ya lo había marcado. Es un
   * UPDATE … WHERE used_at IS NULL: la carrera entre dos usos del mismo token la resuelve la
   * base, no el proceso, así que un reúso concurrente también se detecta.
   */
  markUsed(tokenHash: string, now: Date): Promise<boolean>;
  issue(token: RefreshToken): Promise<void>;
  revoke(session: Session): Promise<void>;
  /** Revoca todas las sesiones vivas del usuario y devuelve sus ids (sid). */
  revokeAllForUser(userId: string, reason: RevocationReason, now: Date): Promise<string[]>;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  /**
   * Verifica contra un hash fijo y descarta el resultado. Sirve para que un email inexistente
   * cueste lo mismo que uno real y el tiempo de respuesta no revele qué cuentas existen.
   */
  verifyDummy(plain: string): Promise<void>;
}

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
