import { Inject, Injectable } from '@nestjs/common';
import { DEMO_USERS, SYSTEM_ROLE_IDS, SYSTEM_ROLES, type SystemRoleName } from '@toka/contracts';
import { DirectoryEntry } from '../../domain/directory/directory-entry';
import {
  ROLE_REPOSITORY,
  type RoleRepository,
  USER_ACCESS_REPOSITORY,
  USER_DIRECTORY_REPOSITORY,
  type UserAccessRepository,
  type UserDirectoryRepository,
} from '../../domain/ports';
import { Role } from '../../domain/role/role';
import { assignmentsChanged, toUserRolesView, type UserRolesView } from '../mappers/views';
import { EVENT_BUS, type EventBus, UNIT_OF_WORK, type UnitOfWork } from '../ports';

const DESCRIPTIONS: Record<SystemRoleName, string> = {
  admin: 'Administración completa de usuarios, roles y asistente',
  auditor: 'Consulta de usuarios y auditoría, sin cambios',
  viewer: 'Consulta básica (rol por defecto de usuarios nuevos)',
};

/**
 * Siembra idempotente al arrancar: roles de sistema (siempre) y, en modo demo, la asignación de
 * los usuarios de demostración. Corre antes de empezar a consumir eventos, para que el
 * `account.registered` del admin no le asigne `viewer` antes de que reciba `admin`.
 */
@Injectable()
export class SeedRolesUseCase {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_ACCESS_REPOSITORY) private readonly access: UserAccessRepository,
    @Inject(USER_DIRECTORY_REPOSITORY) private readonly directory: UserDirectoryRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  async execute(options: { demoUsers: boolean }): Promise<{ createdRoles: string[]; assignedUsers: string[] }> {
    const createdRoles: string[] = [];
    const snapshots: UserRolesView[] = [];
    await this.uow.run(async () => {
      for (const name of Object.keys(SYSTEM_ROLES) as SystemRoleName[]) {
        if (await this.roles.findById(SYSTEM_ROLE_IDS[name])) continue;
        await this.roles.insert(
          Role.system({ id: SYSTEM_ROLE_IDS[name], name, description: DESCRIPTIONS[name], permissions: [...SYSTEM_ROLES[name]] }),
        );
        createdRoles.push(name);
      }
      if (!options.demoUsers) return;
      for (const user of Object.values(DEMO_USERS)) {
        await this.directory.ensureRegistered(DirectoryEntry.registered(user.id, user.email));
        const userAccess = await this.access.get(user.id);
        if (userAccess.assignDefaultIfEmpty(SYSTEM_ROLE_IDS[user.role])) {
          await this.access.save(userAccess, 'seed');
          snapshots.push(toUserRolesView(userAccess, await this.roles.findByIds(userAccess.roles)));
        }
      }
    });
    await this.bus.publish(snapshots.map((s) => assignmentsChanged(s, { id: null, type: 'system' })));
    return { createdRoles, assignedUsers: snapshots.map((s) => s.userId) };
  }
}
