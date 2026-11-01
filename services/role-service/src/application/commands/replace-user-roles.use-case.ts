import { Inject, Injectable } from '@nestjs/common';
import { type Actor, SYSTEM_ROLE_IDS } from '@toka/contracts';
import {
  ROLE_REPOSITORY,
  type RoleRepository,
  USER_ACCESS_REPOSITORY,
  USER_DIRECTORY_REPOSITORY,
  type UserAccessRepository,
  type UserDirectoryRepository,
} from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { assignmentsChanged, toUserRolesView, type UserRolesView } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

export interface ReplaceUserRolesInput {
  roleIds: string[];
  /** Versión leída por el cliente; si se envía, protege contra ediciones concurrentes. */
  assignmentsVersion?: number;
}

@Injectable()
export class ReplaceUserRolesUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_ACCESS_REPOSITORY) private readonly access: UserAccessRepository,
    @Inject(USER_DIRECTORY_REPOSITORY) private readonly directory: UserDirectoryRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(userId: string, input: ReplaceUserRolesInput, actor: Actor): Promise<UserRolesView> {
    const roleIds = [...new Set(input.roleIds)];
    const { view, changed } = await this.uow.run(async () => {
      const entry = await this.directory.find(userId);
      if (!entry) throw new DomainError('USER_NOT_FOUND', 'not_found', 'El usuario no existe');
      const roles = await this.roles.findByIds(roleIds);
      if (roles.length !== roleIds.length) {
        const known = new Set(roles.map((r) => r.id));
        throw new DomainError('UNKNOWN_ROLE', 'unprocessable', `Roles inexistentes: ${roleIds.filter((id) => !known.has(id)).join(', ')}`);
      }

      // Serializa con cualquier otra transacción que cambie admins: sin esto, dos admins que se
      // quitan el rol mutuamente al mismo tiempo pasarían ambos el conteo.
      await this.roles.lockMembership(SYSTEM_ROLE_IDS.admin);
      const userAccess = await this.access.get(userId);
      if (input.assignmentsVersion !== undefined) userAccess.assertVersion(input.assignmentsVersion);
      const changed = userAccess.replaceRoles(roleIds, {
        adminRoleId: SYSTEM_ROLE_IDS.admin,
        actorId: actor.id,
        userIsActive: entry.isActive,
        otherActiveAdmins: await this.access.countActiveMembers(SYSTEM_ROLE_IDS.admin, userId),
      });
      if (changed) await this.access.save(userAccess, actor.id);
      return { view: toUserRolesView(userAccess, roles), changed };
    });

    if (changed) await this.bus.publish([assignmentsChanged(view, actor)]);
    return view;
  }
}
