import type { UserAccess } from './access/user-access';
import type { DirectoryEntry } from './directory/directory-entry';
import type { Role } from './role/role';

/**
 * Puertos de persistencia. El dominio define QUÉ necesita; infrastructure implementa CÓMO
 * (Prisma) y los tests usan implementaciones en memoria con el mismo contrato.
 */
export interface RoleRepository {
  findById(id: string): Promise<Role | null>;
  findByName(name: string): Promise<Role | null>;
  findByIds(ids: string[]): Promise<Role[]>;
  list(): Promise<Role[]>;
  insert(role: Role): Promise<void>;
  /** Lanza VERSION_CONFLICT si la versión en base ya no es role.persistedVersion. */
  update(role: Role): Promise<void>;
  delete(role: Role): Promise<void>;
  memberIds(roleId: string): Promise<string[]>;
  /**
   * Serializa los cambios de membresía de un rol (SELECT … FOR UPDATE sobre su fila) para que
   * dos transacciones concurrentes no dejen al sistema sin admins.
   */
  lockMembership(roleId: string): Promise<void>;
}

export interface UserAccessRepository {
  /** Devuelve el acceso del usuario (vacío, versión 0, si nunca tuvo roles). */
  get(userId: string): Promise<UserAccess>;
  /** Lanza VERSION_CONFLICT si assignmentsVersion cambió en base. */
  save(access: UserAccess, updatedBy: string | null): Promise<void>;
  countActiveMembers(roleId: string, excludingUserId: string): Promise<number>;
}

export interface UserDirectoryRepository {
  find(userId: string): Promise<DirectoryEntry | null>;
  /** Crea la entrada como ACTIVE si no existe (idempotente). */
  ensureRegistered(entry: DirectoryEntry): Promise<void>;
  saveStatus(entry: DirectoryEntry): Promise<void>;
}

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
export const USER_ACCESS_REPOSITORY = Symbol('USER_ACCESS_REPOSITORY');
export const USER_DIRECTORY_REPOSITORY = Symbol('USER_DIRECTORY_REPOSITORY');
