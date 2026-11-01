import { AggregateRoot } from '../shared/aggregate-root';
import { DomainError } from '../shared/domain-error';

export type UserStatus = 'ACTIVE' | 'SUSPENDED';

export type UserProfileEvent =
  | { type: 'ProfileUpdated'; userId: string; changedFields: string[]; version: number }
  | { type: 'StatusChanged'; userId: string; status: UserStatus; previousStatus: UserStatus; reason: string | null; version: number };

/** Datos que la aplicación reúne (bajo lock) para evaluar las reglas de suspensión. */
export interface SuspensionGuard {
  /** Quién suspende (sub del token); null si es el sistema. */
  actorId: string | null;
  /** Si el usuario afectado tiene el rol admin según la proyección local (no según el token). */
  targetIsAdmin: boolean;
  /** Admins ACTIVOS sin contar al usuario afectado. */
  otherActiveAdmins: number;
}

export interface ProfileChanges {
  fullName?: string;
  /** null o cadena vacía borran el valor; undefined no lo toca. */
  department?: string | null;
  jobTitle?: string | null;
}

export interface UserProfileProps {
  id: string;
  email: string;
  fullName: string;
  department: string | null;
  jobTitle: string | null;
  status: UserStatus;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_NAME = 120;
const MAX_FIELD = 80;
const MAX_REASON = 200;

function requiredName(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_NAME) {
    throw new DomainError('INVALID_FULL_NAME', 'validation', `El nombre debe tener entre 1 y ${MAX_NAME} caracteres`);
  }
  return value;
}

function optionalText(raw: string | null | undefined, code: string, label: string): string | null {
  const value = (raw ?? '').trim();
  if (value.length > MAX_FIELD) throw new DomainError(code, 'validation', `${label} admite hasta ${MAX_FIELD} caracteres`);
  return value.length === 0 ? null : value;
}

function optionalReason(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value.length > MAX_REASON) throw new DomainError('INVALID_REASON', 'validation', `El motivo admite hasta ${MAX_REASON} caracteres`);
  return value.length === 0 ? null : value;
}

/**
 * Agregado UserProfile (DDD ligero: es dominio de apoyo). Invariantes: nombre válido, un usuario
 * no se suspende a sí mismo y no se suspende al último admin activo. `version` implementa
 * bloqueo optimista y viaja en los eventos para que los consumidores descarten los reordenados.
 */
export class UserProfile extends AggregateRoot<UserProfileEvent> {
  private constructor(
    readonly id: string,
    readonly email: string,
    private _fullName: string,
    private _department: string | null,
    private _jobTitle: string | null,
    private _status: UserStatus,
    private _statusReason: string | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
    readonly persistedVersion: number,
    private _version: number,
  ) {
    super();
  }

  /** Alta desde account.registered. No registra evento: el perfil nace de un evento, no lo anuncia. */
  static register(input: { id: string; email: string; fullName: string; department?: string | null; jobTitle?: string | null }): UserProfile {
    const now = new Date();
    return new UserProfile(
      input.id,
      input.email.trim().toLowerCase(),
      requiredName(input.fullName),
      optionalText(input.department, 'INVALID_DEPARTMENT', 'El área'),
      optionalText(input.jobTitle, 'INVALID_JOB_TITLE', 'El puesto'),
      'ACTIVE',
      null,
      now,
      now,
      0,
      1,
    );
  }

  static restore(props: UserProfileProps): UserProfile {
    return new UserProfile(
      props.id,
      props.email,
      props.fullName,
      props.department,
      props.jobTitle,
      props.status,
      props.statusReason,
      props.createdAt,
      props.updatedAt,
      props.version,
      props.version,
    );
  }

  get fullName(): string {
    return this._fullName;
  }
  get department(): string | null {
    return this._department;
  }
  get jobTitle(): string | null {
    return this._jobTitle;
  }
  get status(): UserStatus {
    return this._status;
  }
  get statusReason(): string | null {
    return this._statusReason;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get version(): number {
    return this._version;
  }
  get isActive(): boolean {
    return this._status === 'ACTIVE';
  }

  assertVersion(expected: number): void {
    if (expected !== this._version) {
      throw new DomainError('VERSION_CONFLICT', 'conflict', 'El perfil cambió desde que lo leíste; recarga e intenta de nuevo');
    }
  }

  /** Aplica los cambios y devuelve los campos que realmente cambiaron (vacío = nada que guardar). */
  update(changes: ProfileChanges): string[] {
    const next = {
      fullName: changes.fullName === undefined ? this._fullName : requiredName(changes.fullName),
      department: changes.department === undefined ? this._department : optionalText(changes.department, 'INVALID_DEPARTMENT', 'El área'),
      jobTitle: changes.jobTitle === undefined ? this._jobTitle : optionalText(changes.jobTitle, 'INVALID_JOB_TITLE', 'El puesto'),
    };
    const current = { fullName: this._fullName, department: this._department, jobTitle: this._jobTitle };
    const changedFields = (Object.keys(current) as (keyof typeof current)[]).filter((field) => next[field] !== current[field]);
    if (changedFields.length === 0) return [];
    this._fullName = next.fullName;
    this._department = next.department;
    this._jobTitle = next.jobTitle;
    this.touch();
    this.record({ type: 'ProfileUpdated', userId: this.id, changedFields, version: this._version });
    return changedFields;
  }

  /**
   * Suspende al usuario. Reglas, en este orden:
   *  - nadie se suspende a sí mismo (se compara con el id del propio agregado, leído de la base);
   *  - no se suspende dos veces;
   *  - no se puede dejar al sistema sin admins activos.
   */
  suspend(reason: string | null | undefined, guard: SuspensionGuard): void {
    if (guard.actorId === this.id) {
      throw new DomainError('SELF_SUSPENSION', 'conflict', 'No puedes suspenderte a ti mismo');
    }
    if (!this.isActive) throw new DomainError('ALREADY_SUSPENDED', 'conflict', 'El usuario ya está suspendido');
    if (guard.targetIsAdmin && guard.otherActiveAdmins === 0) {
      throw new DomainError('LAST_ADMIN', 'conflict', 'No se puede suspender al último administrador activo');
    }
    this.changeStatus('SUSPENDED', optionalReason(reason));
  }

  reactivate(reason?: string | null): void {
    if (this.isActive) throw new DomainError('ALREADY_ACTIVE', 'conflict', 'El usuario ya está activo');
    this.changeStatus('ACTIVE', optionalReason(reason));
  }

  private changeStatus(status: UserStatus, reason: string | null): void {
    const previousStatus = this._status;
    this._status = status;
    this._statusReason = status === 'SUSPENDED' ? reason : null;
    this.touch();
    this.record({ type: 'StatusChanged', userId: this.id, status, previousStatus, reason, version: this._version });
  }

  private touch(): void {
    this._version = this.persistedVersion + 1;
    this._updatedAt = new Date();
  }
}
