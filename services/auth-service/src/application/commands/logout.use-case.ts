import { Inject, Injectable } from '@nestjs/common';
import { SESSION_REPOSITORY, type SessionRepository } from '../../domain/ports';
import { sha256Hex } from '../../domain/shared/hashing';
import { loggedOut } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

/**
 * Cierre de sesión. Es idempotente y nunca falla: un token desconocido o ya revocado también
 * devuelve "listo", porque un logout que devuelve error solo le sirve a quien está probando
 * cookies ajenas. La autoridad aquí es la posesión de la cookie, no el access token (que puede
 * haber expirado justo antes de que el usuario apriete "salir").
 */
@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(presentedToken: string | null | undefined): Promise<void> {
    if (!presentedToken) return;
    const found = await this.sessions.findByTokenHash(sha256Hex(presentedToken));
    if (!found) return;
    const { session } = found;
    if (!session.revoke('logout', new Date())) return;
    await this.uow.run(() => this.sessions.revoke(session));
    await this.bus.publish([loggedOut(session.userId, session.id, 'user_request')]);
  }
}
