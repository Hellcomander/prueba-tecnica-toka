import { UserAccess } from '../../domain/access/user-access';
import { DirectoryEntry, type DirectoryStatus } from '../../domain/directory/directory-entry';
import { Role } from '../../domain/role/role';

/** Filas de Prisma ↔ dominio. Funciones puras: el dominio nunca ve tipos de Prisma. */
export interface RoleRow {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  version: number;
}

export const roleToDomain = (row: RoleRow): Role =>
  Role.restore({ id: row.id, name: row.name, description: row.description, permissions: row.permissions, isSystem: row.isSystem, version: row.version });

export const roleToRow = (role: Role): RoleRow => ({
  id: role.id,
  name: role.name,
  description: role.description,
  permissions: role.permissions,
  isSystem: role.isSystem,
  version: role.version,
});

export const accessToDomain = (userId: string, row: { assignmentsVersion: number } | null, roleIds: string[]): UserAccess =>
  UserAccess.restore({ userId, roleIds, assignmentsVersion: row?.assignmentsVersion ?? 0 });

export const directoryToDomain = (row: { userId: string; email: string; status: string; statusVersion: number }): DirectoryEntry =>
  new DirectoryEntry(row.userId, row.email, row.status === 'SUSPENDED' ? 'SUSPENDED' : ('ACTIVE' as DirectoryStatus), row.statusVersion);
