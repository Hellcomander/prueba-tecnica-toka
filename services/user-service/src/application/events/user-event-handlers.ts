import { Inject, Injectable } from '@nestjs/common';
import { EVENTS, type IntegrationEvent } from '@toka/contracts';
import { UserProfile } from '../../domain/profile/user-profile';
import { USER_PROFILE_REPOSITORY, USER_ROLES_PROJECTION_REPOSITORY, type UserProfileRepository, type UserRolesProjectionRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { PROCESSED_EVENTS, type ProcessedEvents, STATS_CACHE, type StatsCache, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export type ConsumedEvent = IntegrationEvent<typeof EVENTS.ACCOUNT_REGISTERED> | IntegrationEvent<typeof EVENTS.ROLE_ASSIGNMENTS_CHANGED>;

/**
 * Consumidores de user-service. Cada handler es idempotente: marca el eventId como procesado
 * en la MISMA transacción que su efecto, así que una re-entrega de RabbitMQ no duplica nada.
 * Ninguno publica eventos: el perfil y la proyección son efectos locales.
 */
@Injectable()
export class UserEventHandlers {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly profiles: UserProfileRepository,
    @Inject(USER_ROLES_PROJECTION_REPOSITORY) private readonly projections: UserRolesProjectionRepository,
    @Inject(PROCESSED_EVENTS) private readonly processed: ProcessedEvents,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(STATS_CACHE) private readonly cache: StatsCache,
  ) {}

  async handle(event: ConsumedEvent): Promise<void> {
    if (event.type === EVENTS.ACCOUNT_REGISTERED) return this.onAccountRegistered(event);
    return this.onAssignmentsChanged(event);
  }

  /** Cuenta nueva: crea el perfil. Si ya existe (p. ej. re-entrega con otro eventId) no hace nada. */
  private async onAccountRegistered(event: IntegrationEvent<typeof EVENTS.ACCOUNT_REGISTERED>): Promise<void> {
    const created = await this.uow.run(async () => {
      if (!(await this.processed.markProcessed(event.eventId, event.type))) return false;
      const { userId, email, fullName, department, jobTitle } = event.data;
      if (await this.profiles.findById(userId)) return false;
      const inserted = await this.profiles.insertIfAbsent(UserProfile.register({ id: userId, email, fullName, department, jobTitle }));
      // No insertó y el id no existía: el email ya lo tiene otro perfil. Reintentar no lo arregla.
      if (!inserted) throw new DomainError('EMAIL_TAKEN', 'conflict', `El email de ${userId} ya pertenece a otro perfil`);
      return true;
    });
    if (created) await this.cache.invalidate();
  }

  /** Snapshot de roles del usuario; descarta los más viejos que el último aplicado. */
  private async onAssignmentsChanged(event: IntegrationEvent<typeof EVENTS.ROLE_ASSIGNMENTS_CHANGED>): Promise<void> {
    const applied = await this.uow.run(async () => {
      if (!(await this.processed.markProcessed(event.eventId, event.type))) return false;
      const projection = await this.projections.get(event.data.userId);
      if (!projection.apply(event.data.roles.map((r) => r.name), event.data.assignmentsVersion)) return false;
      await this.projections.save(projection);
      return true;
    });
    if (applied) await this.cache.invalidate();
  }
}
