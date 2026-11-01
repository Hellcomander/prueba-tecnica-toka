import { type Actor, EVENTS, type Permission, type UserAuthorization } from '@toka/contracts';
import type { Account } from '../../domain/account/account';
import type { OutboundEvent } from '../ports';

export interface AccountView {
  id: string;
  email: string;
  status: string;
}

export interface UserInfoView {
  id: string;
  email: string;
  roles: string[];
  permissions: Permission[];
  sessionId: string;
}

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  /** Token opaco en claro: solo viaja a la cookie; en base queda únicamente su SHA-256. */
  refreshToken: string;
  refreshExpiresAt: Date;
  user: UserInfoView;
}

export const toAccountView = (account: Account): AccountView => ({
  id: account.id,
  email: account.email,
  status: account.status,
});

export const toUserInfoView = (account: Account, sessionId: string, authorization: UserAuthorization): UserInfoView => ({
  id: account.id,
  email: account.email,
  roles: authorization.roles,
  permissions: authorization.permissions,
  sessionId,
});

/** Perfil que el admin captura al crear la cuenta: auth no lo guarda, solo lo anuncia. */
export interface RegistrationProfile {
  fullName: string;
  department?: string | null;
  jobTitle?: string | null;
}

export function accountRegistered(account: Account, profile: RegistrationProfile, source: 'admin' | 'seed', actor: Actor): OutboundEvent {
  return {
    type: EVENTS.ACCOUNT_REGISTERED,
    subject: { type: 'user', id: account.id },
    actor,
    data: {
      userId: account.id,
      email: account.email,
      fullName: profile.fullName,
      department: profile.department ?? null,
      jobTitle: profile.jobTitle ?? null,
      source,
    },
  };
}

export interface AttemptContext {
  ip: string | null;
  userAgent?: string | null;
}

export function loginSucceeded(userId: string, sessionId: string, emailHash: string, ctx: AttemptContext): OutboundEvent {
  return {
    type: EVENTS.AUTH_LOGIN_SUCCEEDED,
    subject: { type: 'user', id: userId },
    actor: { id: userId, type: 'user' },
    data: { userId, sid: sessionId, emailHash, ip: ctx.ip, userAgent: ctx.userAgent ?? null },
  };
}

/** El email nunca viaja en claro en los eventos de seguridad: va hasheado (lo exige el catálogo). */
export function loginFailed(
  userId: string | null,
  emailHash: string,
  ctx: AttemptContext,
  reason: 'invalid_credentials' | 'account_disabled' | 'locked',
): OutboundEvent {
  return {
    type: EVENTS.AUTH_LOGIN_FAILED,
    subject: { type: 'user', id: userId ?? emailHash },
    actor: { id: userId, type: 'user' },
    data: { userId, emailHash, ip: ctx.ip, userAgent: ctx.userAgent ?? null, reason },
  };
}

export function accountLocked(emailHash: string, ctx: AttemptContext, lockedUntil: Date): OutboundEvent {
  return {
    type: EVENTS.AUTH_ACCOUNT_LOCKED,
    subject: { type: 'login_attempt', id: emailHash },
    actor: { id: null, type: 'system' },
    data: { emailHash, ip: ctx.ip, lockedUntil: lockedUntil.toISOString() },
  };
}

/**
 * Fin de sesión. `reason` es un campo extra sobre el esquema del catálogo (que es un lector
 * tolerante): distingue el cierre voluntario de la revocación por reúso del refresh, que es lo
 * que a la auditoría le interesa ver.
 */
export function loggedOut(userId: string, sessionId: string, reason: 'user_request' | 'refresh_reuse'): OutboundEvent {
  return {
    type: EVENTS.AUTH_LOGOUT,
    subject: { type: 'session', id: sessionId },
    actor: { id: userId, type: reason === 'user_request' ? 'user' : 'system' },
    data: { userId, sid: sessionId, reason },
  };
}
