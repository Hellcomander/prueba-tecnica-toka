import type { EventBus, OutboundEvent, ProcessedEvents, StatsCache, UnitOfWork } from '../../src/application/ports';
import type { ListUsersParams, UserReadModel, UserStats, UserView } from '../../src/application/queries/read-model';
import type { UserProfileRepository, UserRolesProjectionRepository } from '../../src/domain/ports';
import { UserProfile, type UserProfileProps } from '../../src/domain/profile/user-profile';
import { ADMIN_ROLE_NAME, UserRolesProjection } from '../../src/domain/projection/user-roles-projection';
import { DomainError } from '../../src/domain/shared/domain-error';

/**
 * Implementaciones en memoria de los puertos. Respetan el mismo contrato que los adaptadores
 * reales (incluido el bloqueo optimista, el ON CONFLICT DO NOTHING y el rollback de la unidad de
 * trabajo), así los tests prueban reglas de negocio reales sin mocks de Prisma ni de Redis.
 */
interface State {
  profiles: Map<string, UserProfileProps>;
  projections: Map<string, { roles: string[]; assignmentsVersion: number }>;
  processed: Set<string>;
}

const clone = (s: State): State => structuredClone(s);

export class InMemoryStore {
  state: State = { profiles: new Map(), projections: new Map(), processed: new Set() };
  locks = 0;
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

const toProps = (p: UserProfile): UserProfileProps => ({
  id: p.id,
  email: p.email,
  fullName: p.fullName,
  department: p.department,
  jobTitle: p.jobTitle,
  status: p.status,
  statusReason: p.statusReason,
  version: p.version,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export class InMemoryUserProfileRepository implements UserProfileRepository {
  constructor(private readonly store: InMemoryStore) {}
  async findById(id: string) {
    const p = this.store.state.profiles.get(id);
    return p ? UserProfile.restore(p) : null;
  }
  async insertIfAbsent(profile: UserProfile) {
    const exists = [...this.store.state.profiles.values()].some((p) => p.id === profile.id || p.email === profile.email);
    if (exists) return false;
    this.store.state.profiles.set(profile.id, toProps(profile));
    return true;
  }
  async update(profile: UserProfile) {
    const current = this.store.state.profiles.get(profile.id);
    if (!current || current.version !== profile.persistedVersion) throw new DomainError('VERSION_CONFLICT', 'conflict', 'stale');
    this.store.state.profiles.set(profile.id, toProps(profile));
  }
}

export class InMemoryRolesProjectionRepository implements UserRolesProjectionRepository {
  constructor(private readonly store: InMemoryStore) {}
  async get(userId: string) {
    const p = this.store.state.projections.get(userId);
    return p ? UserRolesProjection.restore({ userId, ...p }) : UserRolesProjection.empty(userId);
  }
  async save(projection: UserRolesProjection) {
    const current = this.store.state.projections.get(projection.userId)?.assignmentsVersion ?? 0;
    if (current !== projection.persistedVersion) throw new DomainError('VERSION_CONFLICT', 'conflict', 'stale');
    this.store.state.projections.set(projection.userId, { roles: projection.roles, assignmentsVersion: projection.version });
  }
  async countActiveAdmins(excludingUserId: string) {
    return [...this.store.state.projections.entries()].filter(
      ([id, p]) => id !== excludingUserId && p.roles.includes(ADMIN_ROLE_NAME) && this.store.state.profiles.get(id)?.status === 'ACTIVE',
    ).length;
  }
  async lockAdminGuard() {
    this.store.locks += 1;
  }
}

const viewOf = (p: UserProfileProps, roles: string[]): UserView => ({
  id: p.id,
  email: p.email,
  fullName: p.fullName,
  department: p.department,
  jobTitle: p.jobTitle,
  status: p.status,
  statusReason: p.statusReason,
  roles: [...roles].sort(),
  version: p.version,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export class InMemoryUserReadModel implements UserReadModel {
  constructor(private readonly store: InMemoryStore) {}
  private rolesOf(id: string) {
    return this.store.state.projections.get(id)?.roles ?? [];
  }
  async list(params: ListUsersParams) {
    const term = params.search?.trim().toLowerCase();
    const all = [...this.store.state.profiles.values()]
      .filter((p) => !params.status || p.status === params.status)
      .filter((p) => !term || p.fullName.toLowerCase().includes(term) || p.email.toLowerCase().includes(term))
      .sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id.localeCompare(b.id));
    const items = all.slice((params.page - 1) * params.pageSize, params.page * params.pageSize).map((p) => viewOf(p, this.rolesOf(p.id)));
    return { items, total: all.length };
  }
  async get(id: string) {
    const p = this.store.state.profiles.get(id);
    return p ? viewOf(p, this.rolesOf(p.id)) : null;
  }
  async stats(): Promise<UserStats> {
    const profiles = [...this.store.state.profiles.values()];
    const active = profiles.filter((p) => p.status === 'ACTIVE');
    const counts = new Map<string, number>();
    for (const p of active) for (const role of this.rolesOf(p.id)) counts.set(role, (counts.get(role) ?? 0) + 1);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return {
      total: profiles.length,
      active: active.length,
      suspended: profiles.length - active.length,
      activeAdmins: counts.get(ADMIN_ROLE_NAME) ?? 0,
      byRole: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, count]) => ({ role, count })),
      newLast7Days: profiles.filter((p) => p.createdAt.getTime() >= since).length,
    };
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

/** Cache en memoria con contadores para comprobar cache-aside e invalidación. */
export class InMemoryStatsCache implements StatsCache {
  value: UserStats | null = null;
  hits = 0;
  invalidations = 0;
  async get() {
    if (this.value) this.hits += 1;
    return this.value;
  }
  async set(stats: UserStats) {
    this.value = stats;
  }
  async invalidate() {
    this.value = null;
    this.invalidations += 1;
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
    profiles: new InMemoryUserProfileRepository(store),
    projections: new InMemoryRolesProjectionRepository(store),
    readModel: new InMemoryUserReadModel(store),
    processed: new InMemoryProcessedEvents(store),
    cache: new InMemoryStatsCache(),
    bus: new RecordingEventBus(),
  };
}
