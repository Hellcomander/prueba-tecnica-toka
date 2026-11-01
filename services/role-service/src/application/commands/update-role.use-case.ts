import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@toka/contracts';
import { ROLE_REPOSITORY, type RoleRepository, USER_ACCESS_REPOSITORY, type UserAccessRepository } from '../../domain/ports';
import { RoleName } from '../../domain/role/role';
import { DomainError } from '../../domain/shared/domain-error';
import { assignmentsChanged, roleEventToOutbound, type RoleView, toRoleView, toUserRolesView, type UserRolesView } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';
import { assertKnownPermissions } from './create-role.use-case';

export interface UpdateRoleInput {
  version: number;
  name?: string;
  description?: string;
  permissions?: string[];
}

@Injectable()
export class UpdateRoleUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_ACCESS_REPOSITORY) private readonly access: UserAccessRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(roleId: string, input: UpdateRoleInput, actor: Actor): Promise<RoleView> {
    if (input.permissions) assertKnownPermissions(input.permissions);

    const { role, snapshots } = await this.uow.run(async () => {
      const role = await this.roles.findById(roleId);
      if (!role) throw new DomainError('ROLE_NOT_FOUND', 'not_found', 'El rol no existe');
      role.assertVersion(input.version);
      if (input.name !== undefined) {
        const other = await this.roles.findByName(RoleName.of(input.name).value);
        if (other && other.id !== role.id) {
          throw new DomainError('ROLE_NAME_TAKEN', 'conflict', `Ya existe un rol llamado "${other.name}"`);
        }
      }
      const { renamed } = role.update(input);
      await this.roles.update(role);

      // Los snapshots de role.assignments_changed llevan el nombre del rol: si cambió, se
      // re-emiten para cada miembro y las proyecciones de otros servicios quedan al día.
      const snapshots: UserRolesView[] = [];
      if (renamed) {
        for (const userId of await this.roles.memberIds(role.id)) {
          const userAccess = await this.access.get(userId);
          userAccess.touch();
          await this.access.save(userAccess, actor.id);
          snapshots.push(toUserRolesView(userAccess, await this.roles.findByIds(userAccess.roles)));
        }
      }
      return { role, snapshots };
    });

    await this.bus.publish([
      ...role.pullDomainEvents().map((e) => roleEventToOutbound(e, actor)),
      ...snapshots.map((s) => assignmentsChanged(s, actor)),
    ]);
    return toRoleView(role);
  }
}
