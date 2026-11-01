import { AggregateRoot } from '../shared/aggregate-root';
import { DomainError } from '../shared/domain-error';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED';

export type AccountEvent =
  | { type: 'AccountRegistered'; accountId: string; email: string }
  | { type: 'AccountStatusChanged'; accountId: string; status: AccountStatus };

/** Value object: email normalizado (minúsculas, sin espacios) y con forma válida. */
export class Email {
  private static readonly PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
  private constructor(readonly value: string) {}

  static of(raw: string): Email {
    const value = raw.trim().toLowerCase();
    if (value.length > 254 || !Email.PATTERN.test(value)) {
      throw new DomainError('INVALID_EMAIL', 'validation', 'El correo no tiene un formato válido');
    }
    return new Email(value);
  }
}

/**
 * Política de contraseña, en el dominio y no en el DTO: es una regla de negocio, no de transporte.
 * El tope de 128 caracteres también protege al servidor (argon2 sobre una entrada enorme es un
 * vector de DoS barato).
 */
export class Password {
  private constructor(readonly value: string) {}

  static of(raw: string): Password {
    if (raw.length < 10 || raw.length > 128 || !/[A-Za-z]/.test(raw) || !/\d/.test(raw)) {
      throw new DomainError('WEAK_PASSWORD', 'validation', 'La contraseña necesita 10–128 caracteres, con al menos una letra y un número');
    }
    return new Password(raw);
  }
}

export interface AccountProps {
  id: string;
  email: string;
  passwordHash: string;
  status: AccountStatus;
  statusVersion: number;
  version: number;
}

/**
 * Agregado Cuenta: la credencial. auth-service es dueño del email y del hash de la contraseña;
 * el perfil (nombre, puesto, departamento) vive en user-service y aquí no se guarda.
 * `statusVersion` viene de user-service (`user.status_changed`) y descarta eventos desordenados;
 * `version` es el bloqueo optimista de la propia fila.
 */
export class Account extends AggregateRoot<AccountEvent> {
  private constructor(
    readonly id: string,
    private readonly _email: Email,
    private readonly _passwordHash: string,
    private _status: AccountStatus,
    private _statusVersion: number,
    readonly persistedVersion: number,
    private _version: number,
  ) {
    super();
  }

  static register(input: { id: string; email: string; passwordHash: string }): Account {
    const account = new Account(input.id, Email.of(input.email), input.passwordHash, 'ACTIVE', 0, 0, 1);
    account.record({ type: 'AccountRegistered', accountId: account.id, email: account.email });
    return account;
  }

  static restore(props: AccountProps): Account {
    return new Account(props.id, Email.of(props.email), props.passwordHash, props.status, props.statusVersion, props.version, props.version);
  }

  get email(): string {
    return this._email.value;
  }
  get passwordHash(): string {
    return this._passwordHash;
  }
  get status(): AccountStatus {
    return this._status;
  }
  get statusVersion(): number {
    return this._statusVersion;
  }
  get version(): number {
    return this._version;
  }
  get isActive(): boolean {
    return this._status === 'ACTIVE';
  }

  /** Una cuenta suspendida no puede entrar ni renovar: la puerta se cierra en el IdP. */
  assertCanAuthenticate(): void {
    if (!this.isActive) {
      throw new DomainError('ACCOUNT_DISABLED', 'forbidden', 'La cuenta está suspendida');
    }
  }

  /** Aplica el estado que manda user-service solo si el evento es más nuevo que el último aplicado. */
  applyStatus(status: AccountStatus, version: number): boolean {
    if (version <= this._statusVersion) return false;
    this._status = status;
    this._statusVersion = version;
    this._version = this.persistedVersion + 1;
    this.record({ type: 'AccountStatusChanged', accountId: this.id, status });
    return true;
  }
}
