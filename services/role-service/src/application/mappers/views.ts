import { type Actor, EVENTS, type Permission, isPermission } from '@toka/contracts';
import type { UserAccess } from '../../domain/access/user-access';
import type { Role, RoleEvent } from '../../domain/role/role';
import type { OutboundEvent } from '../ports';

export interface RoleView {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  version: number;
}

export interface UserRolesView {
  userId: string;
  roles: { id: string; name: string }[];
  assignmentsVersion: number;
}

export const toRoleView = (role: Role): RoleView => ({
  id: role.id,
  name: role.name,
  description: role.description,
  permissions: role.permissions,
  isSystem: role.isSystem,
  version: role.version,
});

export function toUserRolesView(access: UserAccess, roles: Role[]): UserRolesView {
  const byId = new Map(roles.map((r) => [r.id, r]));
  return {
    userId: access.userId,
    roles: access.roles
      .map((id) => byId.get(id))
      .filter((r): r is Role => r !== undefined)
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    assignmentsVersion: access.version,
  };
}

/** Unión de permisos de los roles del usuario (lo que auth mete en el JWT). */
export function permissionsOf(roles: Role[]): Permission[] {
  return [...new Set(roles.flatMap((r) => r.permissions))].filter(isPermission).sort() as Permission[];
}

export function roleEventToOutbound(event: RoleEvent, actor: Actor): OutboundEvent {
  const subject = { type: 'role', id: event.roleId };
  switch (event.type) {
    case 'RoleCreated':
      return { type: EVENTS.ROLE_CREATED, subject, actor, data: { roleId: event.roleId, name: event.name, permissions: event.permissions.filter(isPermission) } };
    case 'RoleUpdated':
      return { type: EVENTS.ROLE_UPDATED, subject, actor, data: { roleId: event.roleId, name: event.name, permissions: event.permissions.filter(isPermission) } };
    case 'RoleDeleted':
      return { type: EVENTS.ROLE_DELETED, subject, actor, data: { roleId: event.roleId, name: event.name } };
  }
}

/** Snapshot completo de los roles del usuario (no un delta): el consumidor queda consistente aunque se haya perdido eventos. */
export function assignmentsChanged(view: UserRolesView, actor: Actor): OutboundEvent {
  return {
    type: EVENTS.ROLE_ASSIGNMENTS_CHANGED,
    subject: { type: 'user', id: view.userId },
    actor,
    data: { userId: view.userId, roles: view.roles, assignmentsVersion: view.assignmentsVersion },
  };
}
