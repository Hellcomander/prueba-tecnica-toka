import type { UserProfile } from './profile/user-profile';
import type { UserRolesProjection } from './projection/user-roles-projection';

/**
 * Puertos de persistencia. El dominio define QUÉ necesita; infrastructure implementa CÓMO
 * (Prisma) y los tests usan implementaciones en memoria con el mismo contrato.
 */
export interface UserProfileRepository {
  findById(id: string): Promise<UserProfile | null>;
  /**
   * Inserta el perfil si no existe (ni el id ni el email). Devuelve false si no insertó, para que
   * el consumidor distinga "ya estaba" (idempotente) de "el email lo tiene otro usuario".
   */
  insertIfAbsent(profile: UserProfile): Promise<boolean>;
  /** Lanza VERSION_CONFLICT si la versión en base ya no es profile.persistedVersion. */
  update(profile: UserProfile): Promise<void>;
}

export interface UserRolesProjectionRepository {
  /** Devuelve la proyección del usuario (vacía, versión 0, si nunca llegó un snapshot). */
  get(userId: string): Promise<UserRolesProjection>;
  /** Lanza VERSION_CONFLICT si assignmentsVersion cambió en base. */
  save(projection: UserRolesProjection): Promise<void>;
  /** Admins con estado ACTIVE (perfil) sin contar a `excludingUserId`. */
  countActiveAdmins(excludingUserId: string): Promise<number>;
  /**
   * Serializa las suspensiones concurrentes (lock de transacción): sin esto, dos admins que se
   * suspenden mutuamente al mismo tiempo pasarían ambos el conteo y el sistema quedaría sin admins.
   */
  lockAdminGuard(): Promise<void>;
}

export const USER_PROFILE_REPOSITORY = Symbol('USER_PROFILE_REPOSITORY');
export const USER_ROLES_PROJECTION_REPOSITORY = Symbol('USER_ROLES_PROJECTION_REPOSITORY');
