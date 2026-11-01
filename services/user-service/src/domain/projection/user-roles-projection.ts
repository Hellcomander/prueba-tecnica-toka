/** Rol de sistema con acceso total. Es inmutable y su nombre es estable, por eso basta el nombre. */
export const ADMIN_ROLE_NAME = 'admin';

/**
 * Proyección local de los roles de un usuario (dueño: role-service). user-service solo la
 * consume: sirve para saber si alguien es admin sin llamar a role-service. `assignmentsVersion`
 * descarta snapshots que lleguen desordenados (role publica el snapshot completo en cada cambio).
 */
export class UserRolesProjection {
  private constructor(
    readonly userId: string,
    private _roles: string[],
    readonly persistedVersion: number,
    private _version: number,
  ) {}

  static restore(props: { userId: string; roles: string[]; assignmentsVersion: number }): UserRolesProjection {
    return new UserRolesProjection(props.userId, [...props.roles].sort(), props.assignmentsVersion, props.assignmentsVersion);
  }

  /** Usuario sin snapshot todavía: sin roles, versión 0. */
  static empty(userId: string): UserRolesProjection {
    return UserRolesProjection.restore({ userId, roles: [], assignmentsVersion: 0 });
  }

  get roles(): string[] {
    return this._roles;
  }
  get version(): number {
    return this._version;
  }
  get isAdmin(): boolean {
    return this._roles.includes(ADMIN_ROLE_NAME);
  }

  /** Aplica el snapshot solo si es más nuevo que el último aplicado. */
  apply(roles: string[], assignmentsVersion: number): boolean {
    if (assignmentsVersion <= this._version) return false;
    this._roles = [...new Set(roles)].sort();
    this._version = assignmentsVersion;
    return true;
  }
}
