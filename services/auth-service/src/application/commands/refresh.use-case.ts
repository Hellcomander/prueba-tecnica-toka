import { Inject, Injectable } from '@nestjs/common';
import { ACCOUNT_REPOSITORY, type AccountRepository, SESSION_REPOSITORY, type SessionRepository } from '../../domain/ports';
import { decideRefresh, invalidRefreshError, RefreshToken, type Session } from '../../domain/session/session';
import { newOpaqueToken, sha256Hex } from '../../domain/shared/hashing';
import { type LoginResult, loggedOut, toUserInfoView } from '../mappers/views';
import {
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

type RotationOutcome =
  | { kind: 'rotated'; session: Session; refreshToken: string; expiresAt: Date }
  | { kind: 'reuse'; userId: string; sessionId: string };

/**
 * Renovación con rotación: cada uso consume el refresh y entrega uno nuevo de la misma sesión.
 * Reusar uno ya rotado significa que alguien tiene una copia (la víctima o el ladrón, no se sabe
 * cuál), así que se revoca la familia entera y ambos tienen que volver a autenticarse.
 */
@Injectable()
export class RefreshUseCase {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    private readonly authorization: AuthorizationResolver,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  async execute(presentedToken: string | null | undefined): Promise<LoginResult> {
    if (!presentedToken) throw invalidRefreshError();
    const now = new Date();
    const tokenHash = sha256Hex(presentedToken);

    const found = await this.sessions.findByTokenHash(tokenHash);
    const decision = decideRefresh(found, now);
    if (!found || decision.kind === 'reject') throw invalidRefreshError();

    const { session } = found;
    const account = await this.accounts.findById(session.userId);
    if (!account) throw invalidRefreshError();

    if (decision.kind === 'reuse') {
      await this.revokeFamily(session);
      throw invalidRefreshError();
    }
    account.assertCanAuthenticate();

    // La llamada a role-service va ANTES de consumir el refresh: si S1 falla, el token del
    // cliente sigue sirviendo y puede reintentar. Rotar primero lo dejaría sin sesión por una
    // caída de un servicio vecino.
    const authorization = await this.authorization.resolve(account.id);

    const outcome = await this.uow.run<RotationOutcome>(async () => {
      // markUsed es un UPDATE condicionado: si otro request ganó la carrera, aquí se entera.
      if (!(await this.sessions.markUsed(tokenHash, now))) {
        session.revoke('refresh_reuse', now);
        await this.sessions.revoke(session);
        return { kind: 'reuse', userId: session.userId, sessionId: session.id };
      }
      const refreshToken = newOpaqueToken();
      const next = RefreshToken.issue({
        tokenHash: sha256Hex(refreshToken),
        sessionId: session.id,
        now,
        lifetimeMs: this.settings.refreshTokenTtlSeconds * 1_000,
      });
      await this.sessions.issue(next);
      return { kind: 'rotated', session, refreshToken, expiresAt: next.expiresAt };
    });

    if (outcome.kind === 'reuse') {
      // El evento se publica fuera de la transacción, ya con la revocación confirmada.
      await this.bus.publish([loggedOut(outcome.userId, outcome.sessionId, 'refresh_reuse')]);
      throw invalidRefreshError();
    }

    const signed = await this.tokens.signAccessToken({
      userId: account.id,
      email: account.email,
      sessionId: session.id,
      roles: authorization.roles,
      permissions: authorization.permissions,
    });
    return {
      accessToken: signed.token,
      expiresIn: signed.expiresInSeconds,
      refreshToken: outcome.refreshToken,
      refreshExpiresAt: outcome.expiresAt,
      user: toUserInfoView(account, session.id, authorization),
    };
  }

  /**
   * Reúso detectado en la lectura: la revocación se confirma en su propia transacción y el evento
   * sale después. Lanzar dentro de la transacción habría revertido justo la revocación.
   */
  private async revokeFamily(session: Session): Promise<void> {
    const revoked = session.revoke('refresh_reuse', new Date());
    if (!revoked) return;
    await this.uow.run(() => this.sessions.revoke(session));
    await this.bus.publish([loggedOut(session.userId, session.id, 'refresh_reuse')]);
  }
}
