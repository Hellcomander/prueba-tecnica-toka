export type DirectoryStatus = 'ACTIVE' | 'SUSPENDED';

/**
 * Proyección local de un usuario (dueño: user-service). Solo guarda lo que role necesita:
 * que existe y si está activo. `statusVersion` descarta eventos que lleguen desordenados.
 */
export class DirectoryEntry {
  constructor(
    readonly userId: string,
    readonly email: string,
    private _status: DirectoryStatus,
    private _statusVersion: number,
  ) {}

  static registered(userId: string, email: string): DirectoryEntry {
    return new DirectoryEntry(userId, email, 'ACTIVE', 0);
  }

  get status(): DirectoryStatus {
    return this._status;
  }
  get statusVersion(): number {
    return this._statusVersion;
  }
  get isActive(): boolean {
    return this._status === 'ACTIVE';
  }

  /** Aplica un cambio de estado solo si es más nuevo que el último aplicado. */
  applyStatus(status: DirectoryStatus, version: number): boolean {
    if (version <= this._statusVersion) return false;
    this._status = status;
    this._statusVersion = version;
    return true;
  }
}
