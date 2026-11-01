import { AggregateRoot } from '../shared/aggregate-root';
import { DomainError } from '../shared/domain-error';

export type RoleEvent =
  | { type: 'RoleCreated'; roleId: string; name: string; permissions: string[] }
  | { type: 'RoleUpdated'; roleId: string; name: string; permissions: string[]; renamed: boolean }
  | { type: 'RoleDeleted'; roleId: string; name: string };

/** Value object: nombre de rol en minúsculas, sin espacios, 3–31 caracteres. */
export class RoleName {
  private static readonly PATTERN = /^[a-z][a-z0-9_-]{2,30}$/;
  private constructor(readonly value: string) {}

  static of(raw: string): RoleName {
    const value = raw.trim().toLowerCase();
    if (!RoleName.PATTERN.test(value)) {
      throw new DomainError('INVALID_ROLE_NAME', 'validation', 'El nombre del rol debe tener 3–31 caracteres: minúsculas, números, - o _');
    }
    return new RoleName(value);
  }
}

export interface RoleProps {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
  version: number;
}

function normalizePermissions(permissions: string[]): string[] {
  const unique = [...new Set(permissions)].sort();
  if (unique.length === 0) {
    throw new DomainError('EMPTY_PERMISSIONS', 'validation', 'Un rol necesita al menos un permiso');
  }
  return unique;
}

/**
 * Agregado Rol. Invariantes: nombre válido, al menos un permiso, los roles de sistema
 * (admin, auditor, viewer) no se modifican ni se borran, y un rol con miembros no se borra.
 * `version` implementa bloqueo optimista: cada cambio la incrementa y el repositorio solo
 * guarda si la versión en base sigue siendo `persistedVersion`.
 */
export class Role extends AggregateRoot<RoleEvent> {
  private constructor(
    readonly id: string,
    private _name: RoleName,
    private _description: string,
    private _permissions: string[],
    readonly isSystem: boolean,
    readonly persistedVersion: number,
    private _version: number,
  ) {
    super();
  }

  static create(input: { id: string; name: string; description?: string; permissions: string[] }): Role {
    const role = new Role(input.id, RoleName.of(input.name), (input.description ?? '').trim(), normalizePermissions(input.permissions), false, 0, 1);
    role.record({ type: 'RoleCreated', roleId: role.id, name: role.name, permissions: role.permissions });
    return role;
  }

  static system(input: { id: string; name: string; description: string; permissions: string[] }): Role {
    return new Role(input.id, RoleName.of(input.name), input.description, normalizePermissions(input.permissions), true, 0, 1);
  }

  static restore(props: RoleProps): Role {
    return new Role(props.id, RoleName.of(props.name), props.description, [...props.permissions].sort(), props.isSystem, props.version, props.version);
  }

  get name(): string {
    return this._name.value;
  }
  get description(): string {
    return this._description;
  }
  get permissions(): string[] {
    return [...this._permissions];
  }
  get version(): number {
    return this._version;
  }

  /** El cliente manda la versión que leyó; si no coincide, otro cambio ganó antes (409). */
  assertVersion(expected: number): void {
    if (expected !== this._version) {
      throw new DomainError('VERSION_CONFLICT', 'conflict', 'El rol cambió desde que lo leíste; recarga e intenta de nuevo');
    }
  }

  update(changes: { name?: string; description?: string; permissions?: string[] }): { renamed: boolean } {
    if (this.isSystem) {
      throw new DomainError('SYSTEM_ROLE_IMMUTABLE', 'conflict', 'Los roles de sistema no se pueden modificar');
    }
    const name = changes.name !== undefined ? RoleName.of(changes.name) : this._name;
    const permissions = changes.permissions !== undefined ? normalizePermissions(changes.permissions) : this._permissions;
    const description = changes.description !== undefined ? changes.description.trim() : this._description;
    const renamed = name.value !== this._name.value;
    const changed = renamed || description !== this._description || permissions.join() !== this._permissions.join();
    if (!changed) return { renamed: false };

    this._name = name;
    this._description = description;
    this._permissions = permissions;
    this._version = this.persistedVersion + 1;
    this.record({ type: 'RoleUpdated', roleId: this.id, name: this.name, permissions: this.permissions, renamed });
    return { renamed };
  }

  markDeleted(memberCount: number): void {
    if (this.isSystem) {
      throw new DomainError('SYSTEM_ROLE_IMMUTABLE', 'conflict', 'Los roles de sistema no se pueden eliminar');
    }
    if (memberCount > 0) {
      throw new DomainError('ROLE_IN_USE', 'conflict', `El rol tiene ${memberCount} usuario(s) asignado(s); reasígnalos antes de eliminarlo`);
    }
    this.record({ type: 'RoleDeleted', roleId: this.id, name: this.name });
  }
}
