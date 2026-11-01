import type { EventBus, OutboundEvent, ProcessedEvents, UnitOfWork } from '../../src/application/ports';
import { UserAccess } from '../../src/domain/access/user-access';
import { DirectoryEntry } from '../../src/domain/directory/directory-entry';
import type { RoleRepository, UserAccessRepository, UserDirectoryRepository } from '../../src/domain/ports';
import { Role, type RoleProps } from '../../src/domain/role/role';
import { DomainError } from '../../src/domain/shared/domain-error';

/**
 * Implementaciones en memoria de los puertos. Respetan el mismo contrato que los repositorios
 * Prisma (incluido el bloqueo optimista y el rollback de la unidad de trabajo), así los tests
 * prueban reglas de negocio reales sin mocks de Prisma.
 */
interface State {
  roles: Map<string, RoleProps>;
  access: Map<string, { roleIds: string[]; assignmentsVersion: number }>;
  directory: Map<string, { email: string; status: 'ACTIVE' | 'SUSPENDED'; statusVersion: number }>;
  processed: Set<string>;
}

const clone = (s: State): State => structuredClone(s);

export class InMemoryStore {
  state: State = { roles: new Map(), access: new Map(), directory: new Map(), processed: new Set() };
  locks: string[] = [];
}

export class FakeUnitOfWork implements UnitOfWork {
  constructor(private readonly store: InMemoryStore) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    const snapshot = clone(this.store.state);
    try {
      return await work();
    } catch (error) {
      this.store.state = snapshot; // rollback
      throw error;
    }
  }
}

export class InMemoryRoleRepository implements RoleRepository {
  constructor(private readonly store: InMemoryStore) {}
  private toDomain(p: RoleProps): Role {
    return Role.restore(p);
  }
  async findById(id: string) {
    const p = this.store.state.roles.get(id);
    return p ? this.toDomain(p) : null;
  }
  async findByName(name: string) {
    const p = [...this.store.state.roles.values()].find((r) => r.name === name);
    return p ? this.toDomain(p) : null;
  }
  async findByIds(ids: string[]) {
    return ids.map((id) => this.store.state.roles.get(id)).filter((p): p is RoleProps => !!p).map((p) => this.toDomain(p));
  }
  async list() {
    return [...this.store.state.roles.values()].map((p) => this.toDomain(p));
  }
  async insert(role: Role) {
    if (this.store.state.roles.has(role.id) || (await this.findByName(role.name))) {
      throw new DomainError('ROLE_NAME_TAKEN', 'conflict', 'duplicado');
    }
    this.store.state.roles.set(role.id, { id: role.id, name: role.name, description: role.description, permissions: role.permissions, isSystem: role.isSystem, version: role.version });
  }
  async update(role: Role) {
    const current = this.store.state.roles.get(role.id);
    if (!current || current.version !== role.persistedVersion) throw new DomainError('VERSION_CONFLICT', 'conflict', 'stale');
    this.store.state.roles.set(role.id, { ...current, name: role.name, description: role.description, permissions: role.permissions, version: role.version });
  }
  async delete(role: Role) {
    this.store.state.roles.delete(role.id);
  }
  async memberIds(roleId: string) {
    return [...this.store.state.access.entries()].filter(([, a]) => a.roleIds.includes(roleId)).map(([id]) => id);
  }
  async lockMembership(roleId: string) {
    this.store.locks.push(roleId);
  }
}

export class InMemoryUserAccessRepository implements UserAccessRepository {
  constructor(private readonly store: InMemoryStore) {}
  async get(userId: string) {
    const a = this.store.state.access.get(userId);
    return UserAccess.restore({ userId, roleIds: a?.roleIds ?? [], assignmentsVersion: a?.assignmentsVersion ?? 0 });
  }
  async save(access: UserAccess) {
    const current = this.store.state.access.get(access.userId)?.assignmentsVersion ?? 0;
    if (current !== access.persistedVersion) throw new DomainError('VERSION_CONFLICT', 'conflict', 'stale');
    this.store.state.access.set(access.userId, { roleIds: access.roles, assignmentsVersion: access.version });
  }
  async countActiveMembers(roleId: string, excludingUserId: string) {
    return [...this.store.state.access.entries()].filter(
      ([id, a]) => id !== excludingUserId && a.roleIds.includes(roleId) && this.store.state.directory.get(id)?.status === 'ACTIVE',
    ).length;
  }
}

export class InMemoryDirectoryRepository implements UserDirectoryRepository {
  constructor(private readonly store: InMemoryStore) {}
  async find(userId: string) {
    const d = this.store.state.directory.get(userId);
    return d ? new DirectoryEntry(userId, d.email, d.status, d.statusVersion) : null;
  }
  async ensureRegistered(entry: DirectoryEntry) {
    if (!this.store.state.directory.has(entry.userId)) {
      this.store.state.directory.set(entry.userId, { email: entry.email, status: entry.status, statusVersion: entry.statusVersion });
    }
  }
  async saveStatus(entry: DirectoryEntry) {
    const d = this.store.state.directory.get(entry.userId)!;
    this.store.state.directory.set(entry.userId, { ...d, status: entry.status, statusVersion: entry.statusVersion });
  }
}

export class InMemoryProcessedEvents implements ProcessedEvents {
  constructor(private readonly store: InMemoryStore) {}
  async markProcessed(eventId: string) {
    if (this.store.state.processed.has(eventId)) return false;
    this.store.state.processed.add(eventId);
    return true;
  }
}

export class RecordingEventBus implements EventBus {
  published: OutboundEvent[] = [];
  async publish(events: OutboundEvent[]) {
    this.published.push(...events);
  }
  types() {
    return this.published.map((e) => e.type);
  }
}

/** Arma todas las piezas en memoria para un test. */
export function inMemoryContext() {
  const store = new InMemoryStore();
  return {
    store,
    uow: new FakeUnitOfWork(store),
    roles: new InMemoryRoleRepository(store),
    access: new InMemoryUserAccessRepository(store),
    directory: new InMemoryDirectoryRepository(store),
    processed: new InMemoryProcessedEvents(store),
    bus: new RecordingEventBus(),
  };
}
