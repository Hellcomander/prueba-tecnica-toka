import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Email } from '../../domain/account/account';
import { ACCOUNT_REPOSITORY, type AccountRepository, PASSWORD_HASHER, type PasswordHasher, SESSION_REPOSITORY, type SessionRepository } from '../../domain/ports';
import { attemptKey } from '../../domain/security/lockout-policy';
import { RefreshToken, Session } from '../../domain/session/session';
import { DomainError, TooManyAttemptsError } from '../../domain/shared/domain-error';
import { newOpaqueToken, sha256Hex } from '../../domain/shared/hashing';
import { type AttemptContext, accountLocked, type LoginResult, loginFailed, loginSucceeded, toUserInfoView } from '../mappers/views';
import {
  ATTEMPT_LIMITER,
  type AttemptLimiter,
  AUTH_SETTINGS,
  type AuthSettings,
  EVENT_BUS,
  type EventBus,
  TOKEN_SIGNER,
  type TokenSigner,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../ports';
import { AuthorizationResolver } from '../services/authorization-resolver';

export interface LoginInput {
  email: string;
  password: string;
}

/** Mismo error para "no existe" y "contraseña incorrecta": no se enumera quién tiene cuenta. */
const invalidCredentials = () => new DomainError('INVALID_CREDENTIALS', 'unauthorized', 'Correo o contraseña incorrectos');

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ATTEMPT_LIMITER) private readonly limiter: AttemptLimiter,
    private readonly authorization: AuthorizationResolver,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  async execute(input: LoginInput, ctx: AttemptContext): Promise<LoginResult> {
    const email = Email.of(input.email).value;
    const emailHash = sha256Hex(email);
    const key = attemptKey(emailHash, ctx.ip);

    const lock = await this.limiter.status(key);
    if (lock.locked) {
      await this.bus.publish([loginFailed(null, emailHash, ctx, 'locked')]);
      throw new TooManyAttemptsError(lock.retryAfterSeconds);
    }

    const account = await this.accounts.findByEmail(email);
    if (!account) {
      // Verificación "dummy" contra un hash fijo: un correo inexistente cuesta lo mismo que uno
      // real, así que el tiempo de respuesta no delata qué cuentas existen.
      await this.hasher.verifyDummy(input.password);
      await this.registerFailure(key, null, emailHash, ctx);
      throw invalidCredentials();
    }
    if (!(await this.hasher.verify(account.passwordHash, input.password))) {
      await this.registerFailure(key, account.id, emailHash, ctx);
      throw invalidCredentials();
    }
    // El estado se revisa DESPUÉS de la contraseña: quien no acierta la credencial tampoco se
    // entera de si la cuenta existe y está suspendida.
    if (!account.isActive) {
      await this.bus.publish([loginFailed(account.id, emailHash, ctx, 'account_disabled')]);
      account.assertCanAuthenticate();
    }

    // Antes de abrir la sesión: si no sabemos qué permisos tiene, no se emite token (falla cerrado).
    const authorization = await this.authorization.resolve(account.id);

    const now = new Date();
    const session = Session.start({ id: randomUUID(), userId: account.id, now, lifetimeMs: this.settings.sessionTtlSeconds * 1_000 });
    const refreshToken = newOpaqueToken();
    const token = RefreshToken.issue({
      tokenHash: sha256Hex(refreshToken),
      sessionId: session.id,
      now,
      lifetimeMs: this.settings.refreshTokenTtlSeconds * 1_000,
    });
    await this.uow.run(() => this.sessions.start(session, token));
    await this.limiter.reset(key);

    const signed = await this.tokens.signAccessToken({
      userId: account.id,
      email: account.email,
      sessionId: session.id,
      roles: authorization.roles,
      permissions: authorization.permissions,
    });
    await this.bus.publish([loginSucceeded(account.id, session.id, emailHash, ctx)]);

    return {
      accessToken: signed.token,
      expiresIn: signed.expiresInSeconds,
      refreshToken,
      refreshExpiresAt: token.expiresAt,
      user: toUserInfoView(account, session.id, authorization),
    };
  }

  /** Cuenta el fallo y, si el backoff acaba de activarse, anuncia el bloqueo a la auditoría. */
  private async registerFailure(key: string, userId: string | null, emailHash: string, ctx: AttemptContext): Promise<void> {
    const { lockedUntil } = await this.limiter.registerFailure(key);
    const events = [loginFailed(userId, emailHash, ctx, 'invalid_credentials')];
    if (lockedUntil) events.push(accountLocked(emailHash, ctx, lockedUntil));
    await this.bus.publish(events);
  }
}
