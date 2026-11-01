import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@toka/contracts';
import { USER_PROFILE_REPOSITORY, USER_ROLES_PROJECTION_REPOSITORY, type UserProfileRepository, type UserRolesProjectionRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { profileEventToOutbound, toUserView, type UserView } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export interface UpdateProfileInput {
  /** Versión leída por el cliente; si se envía, protege contra ediciones concurrentes. */
  version?: number;
  fullName?: string;
  department?: string | null;
  jobTitle?: string | null;
}

/** Sirve a PATCH /users/me y a PATCH /users/:id: la diferencia es solo quién es el `userId`. */
@Injectable()
export class UpdateProfileUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY) private readonly profiles: UserProfileRepository,
    @Inject(USER_ROLES_PROJECTION_REPOSITORY) private readonly projections: UserRolesProjectionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(userId: string, input: UpdateProfileInput, actor: Actor): Promise<UserView> {
    const { profile, view } = await this.uow.run(async () => {
      const found = await this.profiles.findById(userId);
      if (!found) throw new DomainError('USER_NOT_FOUND', 'not_found', 'El usuario no existe');
      if (input.version !== undefined) found.assertVersion(input.version);
      const changed = found.update({ fullName: input.fullName, department: input.department, jobTitle: input.jobTitle });
      if (changed.length > 0) await this.profiles.update(found);
      return { profile: found, view: toUserView(found, (await this.projections.get(userId)).roles) };
    });

    await this.bus.publish(profile.pullDomainEvents().map((e) => profileEventToOutbound(e, actor)));
    return view;
  }
}
