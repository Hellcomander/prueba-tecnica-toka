import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@toka/contracts';
import { USER_PROFILE_REPOSITORY, USER_ROLES_PROJECTION_REPOSITORY, type UserProfileRepository, type UserRolesProjectionRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { profileEventToOutbound, toUserView, type UserView } from '../mappers/views';
import { EVENT_BUS, type EventBus, STATS_CACHE, type StatsCache, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export interface ChangeStatusInput {
  /** Versión leída por el cliente; si se envía, protege contra ediciones concurrentes. */
  version?: number;
  reason?: string;
}

@Injectable()
export class SuspendUserUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly profiles: UserProfileRepository,
    @Inject(USER_ROLES_PROJECTION_REPOSITORY) private readonly projections: UserRolesProjectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(STATS_CACHE) private readonly cache: StatsCache,
  ) {}

  async execute(userId: string, input: ChangeStatusInput, actor: Actor): Promise<UserView> {
    const { profile, view } = await this.uow.run(async () => {
      // Serializa con cualquier otra suspensión: sin esto, dos admins que se suspenden entre sí
      // al mismo tiempo pasarían ambos el conteo de admins activos.
      await this.projections.lockAdminGuard();
      const found = await this.profiles.findById(userId);
      if (!found) throw new DomainError('USER_NOT_FOUND', 'not_found', 'El usuario no existe');
      if (input.version !== undefined) found.assertVersion(input.version);
      // El estado y los roles salen de la base propia (perfil + proyección), nunca de los claims del token.
      const projection = await this.projections.get(userId);
      found.suspend(input.reason, {
        actorId: actor.id,
        targetIsAdmin: projection.isAdmin,
        otherActiveAdmins: await this.projections.countActiveAdmins(userId),
      });
      await this.profiles.update(found);
      return { profile: found, view: toUserView(found, projection.roles) };
    });

    await this.bus.publish(profile.pullDomainEvents().map((e) => profileEventToOutbound(e, actor)));
    await this.cache.invalidate();
    return view;
  }
}

@Injectable()
export class ReactivateUserUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly profiles: UserProfileRepository,
    @Inject(USER_ROLES_PROJECTION_REPOSITORY) private readonly projections: UserRolesProjectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(STATS_CACHE) private readonly cache: StatsCache,
  ) {}

  async execute(userId: string, input: ChangeStatusInput, actor: Actor): Promise<UserView> {
    const { profile, view } = await this.uow.run(async () => {
      const found = await this.profiles.findById(userId);
      if (!found) throw new DomainError('USER_NOT_FOUND', 'not_found', 'El usuario no existe');
      if (input.version !== undefined) found.assertVersion(input.version);
      found.reactivate(input.reason);
      await this.profiles.update(found);
      return { profile: found, view: toUserView(found, (await this.projections.get(userId)).roles) };
    });

    await this.bus.publish(profile.pullDomainEvents().map((e) => profileEventToOutbound(e, actor)));
    await this.cache.invalidate();
    return view;
  }
}
