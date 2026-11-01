import { Inject, Injectable } from '@nestjs/common';
import { EVENTS, type IntegrationEvent } from '@toka/contracts';
import { ACCOUNT_REPOSITORY, type AccountRepository, SESSION_REPOSITORY, type SessionRepository } from '../../domain/ports';
import { PROCESSED_EVENTS, type ProcessedEvents, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export type ConsumedEvent = IntegrationEvent<typeof EVENTS.USER_STATUS_CHANGED>;

/** Error transitorio: el evento llegó antes de que la cuenta existiera; el reintento lo resuelve. */
export class AccountNotYetKnownError extends Error {
  override readonly name = 'AccountNotYetKnownError';
}

/**
 * Consumidor de auth-service. user-service es dueño del ciclo de vida del usuario; auth refleja
 * el estado para cerrar la puerta: un usuario suspendido no puede entrar ni renovar, y además se
 * le revocan las sesiones abiertas (si no, su access token seguiría sirviendo hasta 10 minutos
 * y podría renovarlo indefinidamente).
 *
 * Idempotente: el eventId se marca como procesado en la MISMA transacción que el efecto.
 */
@Injectable()
export class AuthEventHandlers {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(PROCESSED_EVENTS) private readonly processed: ProcessedEvents,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  async handle(event: ConsumedEvent): Promise<void> {
    await this.uow.run(async () => {
      if (!(await this.processed.markProcessed(event.eventId, event.type))) return;
      const account = await this.accounts.findById(event.data.userId);
      if (!account) throw new AccountNotYetKnownError(`La cuenta ${event.data.userId} aún no existe`);
      // `version` descarta eventos más viejos que el último aplicado (RabbitMQ no ordena entre reintentos).
      if (!account.applyStatus(event.data.status, event.data.version)) return;
      await this.accounts.update(account);
      account.pullDomainEvents();
      if (!account.isActive) await this.sessions.revokeAllForUser(account.id, 'user_suspended', new Date());
    });
  }
}
