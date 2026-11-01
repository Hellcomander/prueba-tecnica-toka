import { Inject, Injectable } from '@nestjs/common';
import { EVENTS, type IntegrationEvent, SYSTEM_ROLE_IDS } from '@toka/contracts';
import { DirectoryEntry } from '../../domain/directory/directory-entry';
import {
  ROLE_REPOSITORY,
  type RoleRepository,
  USER_ACCESS_REPOSITORY,
  USER_DIRECTORY_REPOSITORY,
  type UserAccessRepository,
  type UserDirectoryRepository,
} from '../../domain/ports';
import { assignmentsChanged, toUserRolesView, type UserRolesView } from '../mappers/views';
import { EVENT_BUS, type EventBus, PROCESSED_EVENTS, type ProcessedEvents, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export type ConsumedEvent = IntegrationEvent<typeof EVENTS.ACCOUNT_REGISTERED> | IntegrationEvent<typeof EVENTS.USER_STATUS_CHANGED>;

/** Error transitorio: el evento llegó antes que el que crea al usuario; el reintento diferido lo resuelve. */
export class UserNotYetKnownError extends Error {
  override readonly name = 'UserNotYetKnownError';
}

/**
 * Consumidores de role-service. Cada handler es idempotente: marca el eventId como procesado
 * en la MISMA transacción que su efecto, así que una re-entrega de RabbitMQ no duplica nada.
 */
@Injectable()
export class RoleEventHandlers {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_ACCESS_REPOSITORY) private readonly access: UserAccessRepository,
    @Inject(USER_DIRECTORY_REPOSITORY) private readonly directory: UserDirectoryRepository,
    @Inject(PROCESSED_EVENTS) private readonly processed: ProcessedEvents,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async handle(event: ConsumedEvent): Promise<void> {
    if (event.type === EVENTS.ACCOUNT_REGISTERED) return this.onAccountRegistered(event);
    return this.onUserStatusChanged(event);
  }

  /** Usuario nuevo: entra al directorio local y recibe el rol por defecto si no tiene ninguno. */
  private async onAccountRegistered(event: IntegrationEvent<typeof EVENTS.ACCOUNT_REGISTERED>): Promise<void> {
    const snapshot = await this.uow.run<UserRolesView | null>(async () => {
      if (!(await this.processed.markProcessed(event.eventId, event.type))) return null;
      await this.directory.ensureRegistered(DirectoryEntry.registered(event.data.userId, event.data.email));
      const userAccess = await this.access.get(event.data.userId);
      if (!userAccess.assignDefaultIfEmpty(SYSTEM_ROLE_IDS.viewer)) return null;
      await this.access.save(userAccess, 'system');
      return toUserRolesView(userAccess, await this.roles.findByIds(userAccess.roles));
    });
    if (snapshot) await this.bus.publish([assignmentsChanged(snapshot, { id: null, type: 'system' })]);
  }

  /** Estado del usuario en el directorio local; descarta eventos más viejos que el último aplicado. */
  private async onUserStatusChanged(event: IntegrationEvent<typeof EVENTS.USER_STATUS_CHANGED>): Promise<void> {
    await this.uow.run(async () => {
      if (!(await this.processed.markProcessed(event.eventId, event.type))) return;
      const entry = await this.directory.find(event.data.userId);
      if (!entry) throw new UserNotYetKnownError(`Usuario ${event.data.userId} aún no está en el directorio`);
      if (entry.applyStatus(event.data.status, event.data.version)) await this.directory.saveStatus(entry);
    });
  }
}
