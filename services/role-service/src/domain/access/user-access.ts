import { AggregateRoot } from '../shared/aggregate-root';
import { DomainError } from '../shared/domain-error';

export type UserAccessEvent = { type: 'UserRolesChanged'; userId: string; roleIds: string[]; assignmentsVersion: number };

/** Datos que la aplicación reúne (bajo lock) para evaluar la regla del último admin. */
export interface AdminGuardContext {
  adminRoleId: string;
  /** Quién hace el cambio (sub del token); null si es el sistema. */
  actorId: string | null;
  /** Si el usuario afectado está ACTIVE en el directorio local. */
  userIsActive: boolean;
  /** Admins ACTIVOS sin contar al usuario afectado. */
  otherActiveAdmins: number;
}

/**
 * Agregado con los roles de UN usuario. `assignmentsVersion` crece en cada cambio: sirve como
 * bloqueo optimista y como versión del snapshot que publica role.assignments_changed (los
 * consumidores descartan snapshots más viejos que el último aplicado).
 */
export class UserAccess extends AggregateRoot<UserAccessEvent> {
  private constructor(
    readonly userId: string,
    private roleIds: Set<string>,
    readonly persistedVersion: number,
    private _version: number,
  ) {
    super();
  }

  static restore(props: { userId: string; roleIds: string[]; assignmentsVersion: number }): UserAccess {
    return new UserAccess(props.userId, new Set(props.roleIds), props.assignmentsVersion, props.assignmentsVersion);
  }

  get roles(): string[] {
    return [...this.roleIds].sort();
  }
  get version(): number {
    return this._version;
  }

  hasRole(roleId: string): boolean {
    return this.roleIds.has(roleId);
  }

  assertVersion(expected: number): void {
    if (expected !== this._version) {
      throw new DomainError('VERSION_CONFLICT', 'conflict', 'Las asignaciones cambiaron desde que las leíste; recarga e intenta de nuevo');
    }
  }

  /**
   * Reemplaza el conjunto de roles. Reglas:
   *  - nadie se quita a sí mismo el rol admin (evita quedarse fuera por error);
   *  - no se puede dejar al sistema sin admins activos.
   */
  replaceRoles(newRoleIds: string[], guard: AdminGuardContext): boolean {
    const next = new Set(newRoleIds);
    const unchanged = next.size === this.roleIds.size && [...next].every((id) => this.roleIds.has(id));
    if (unchanged) return false;

    const losesAdmin = this.roleIds.has(guard.adminRoleId) && !next.has(guard.adminRoleId);
    if (losesAdmin && guard.actorId === this.userId) {
      throw new DomainError('SELF_ADMIN_REMOVAL', 'conflict', 'No puedes quitarte a ti mismo el rol admin');
    }
    if (losesAdmin && guard.userIsActive && guard.otherActiveAdmins === 0) {
      throw new DomainError('LAST_ADMIN', 'conflict', 'No se puede quitar el rol admin al último administrador activo');
    }
    this.apply(next);
    return true;
  }

  /** Rol por defecto para usuarios nuevos: solo si todavía no tienen ninguno (idempotente). */
  assignDefaultIfEmpty(defaultRoleId: string): boolean {
    if (this.roleIds.size > 0) return false;
    this.apply(new Set([defaultRoleId]));
    return true;
  }

  /** Re-emite el snapshot sin cambiar roles (p. ej. al renombrar un rol que el usuario tiene). */
  touch(): void {
    this.apply(this.roleIds);
  }

  private apply(next: Set<string>): void {
    this.roleIds = next;
    this._version = this.persistedVersion + 1;
    this.record({ type: 'UserRolesChanged', userId: this.userId, roleIds: this.roles, assignmentsVersion: this._version });
  }
}
