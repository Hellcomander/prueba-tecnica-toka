import { Inject, Injectable } from '@nestjs/common';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS, type UserAuthorization } from '@toka/contracts';
import { ROLE_REPOSITORY, type RoleRepository, USER_ACCESS_REPOSITORY, type UserAccessRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { permissionsOf, type RoleView, toRoleView, toUserRolesView, type UserRolesView } from '../mappers/views';

/** Lado de lectura (CQRS ligero): no pasa por transacciones ni emite eventos. */
@Injectable()
export class ListRolesQuery {
  constructor(@Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository) {}

  async execute(): Promise<RoleView[]> {
    return (await this.roles.list()).map(toRoleView).sort((a, b) => a.name.localeCompare(b.name));
  }
}

@Injectable()
export class GetRoleQuery {
  constructor(@Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository) {}

  async execute(roleId: string): Promise<RoleView> {
    const role = await this.roles.findById(roleId);
    if (!role) throw new DomainError('ROLE_NOT_FOUND', 'not_found', 'El rol no existe');
    return toRoleView(role);
  }
}

@Injectable()
export class ListPermissionsQuery {
  execute(): { code: string; description: string }[] {
    return PERMISSIONS.map((code) => ({ code, description: PERMISSION_DESCRIPTIONS[code] }));
  }
}

@Injectable()
export class GetUserRolesQuery {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_ACCESS_REPOSITORY) private readonly access: UserAccessRepository,
  ) {}

  async execute(userId: string): Promise<UserRolesView> {
    const userAccess = await this.access.get(userId);
    return toUserRolesView(userAccess, await this.roles.findByIds(userAccess.roles));
  }
}

/**
 * S1: roles y permisos efectivos de un usuario para que auth los firme en el JWT. Un usuario
 * desconocido devuelve listas vacías (200), no 404: auth emite un token sin permisos.
 */
@Injectable()
export class GetAuthorizationQuery {
  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepository,
    @Inject(USER_ACCESS_REPOSITORY) private readonly access: UserAccessRepository,
  ) {}

  async execute(userId: string): Promise<UserAuthorization> {
    const userAccess = await this.access.get(userId);
    const roles = await this.roles.findByIds(userAccess.roles);
    return { userId, roles: roles.map((r) => r.name).sort(), permissions: permissionsOf(roles) };
  }
}
