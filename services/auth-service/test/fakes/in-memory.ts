import type { UserAuthorization } from '@toka/contracts';
import type {
  AccessTokenRequest,
  AttemptFailure,
  AttemptLimiter,
  AttemptStatus,
  AuthorizationCache,
  AuthorizationProvider,
  AuthSettings,
  EventBus,
  OutboundEvent,
  ProcessedEvents,
  SignedAccessToken,
  TokenSigner,
  UnitOfWork,
} from '../../src/application/ports';
import { AuthorizationResolver } from '../../src/application/services/authorization-resolver';
import { Account } from '../../src/domain/account/account';
import type { AccountRepository, PasswordHasher, SessionRepository } from '../../src/domain/ports';
import { lockDurationMs } from '../../src/domain/security/lockout-policy';
import { RefreshToken, type RevocationReason, Session } from '../../src/domain/session/session';
import { DomainError } from '../../src/domain/shared/domain-error';

/**
 * Implementaciones en memoria de los puertos. Respetan el mismo contrato que los adaptadores
 * reales (bloqueo optimista, rollback de la unidad de trabajo, markUsed condicionado), así los
 * tests prueban reglas de seguridad de verdad y no un mock de Prisma, Redis o RabbitMQ.
 */
interface AccountState {
  id: string;
  email: string;
  passwordHash: string;
  status: 'ACTIVE' | 'SUSPENDED';
  statusVersion: number;
  version: number;
}

interface SessionState {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevocationReason | null;
}

interface TokenState {
  tokenHash: string;
  sessionId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface State {
  accounts: Map<string, AccountState>;
  sessions: Map<string, SessionState>;
  tokens: Map<string, TokenState>;
  processed: Set<string>;
}

const clone = (s: State): State => structuredClone(s);

export class InMemoryStore {
  state: State = { accounts: new Map(), sessions: new Map(), tokens: new Map(), processed: new Set() };
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

export class InMemoryAccountRepository implements AccountRepository {
  constructor(private readonly store: InMemoryStore) {}

  private toDomain(s: AccountState): Account {
    return Account.restore(s);
  }

  async findById(id: string) {
    const s = this.store.state.accounts.get(id);
    return s ? this.toDomain(s) : null;
  }

  async findByEmail(email: string) {
    const s = [...this.store.state.accounts.values()].find((a) => a.email === email);
    return s ? this.toDomain(s) : null;
  }

  async insert(account: Account) {
    if (await this.findByEmail(account.email)) throw new DomainError('EMAIL_TAKEN', 'conflict', 'duplicado');
    this.store.state.accounts.set(account.id, {
      id: account.id,
      email: account.email,
      passwordHash: account.passwordHash,
      status: account.status,
      statusVersion: account.statusVersion,
      version: account.version,
    });
  }

  async update(account: Account) {
    const current = this.store.state.accounts.get(account.id);
    if (!current || current.version !== account.persistedVersion) throw new DomainError('VERSION_CONFLICT', 'conflict', 'stale');
    this.store.state.accounts.set(account.id, {
      ...current,
      status: account.status,
      statusVersion: account.statusVersion,
      version: account.version,
    });
  }
}

export class InMemorySessionRepository implements SessionRepository {
  constructor(private readonly store: InMemoryStore) {}

  async start(session: Session, token: RefreshToken) {
    this.store.state.sessions.set(session.id, {
      id: session.id,
      userId: session.userId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
    });
    await this.issue(token);
  }

  async findByTokenHash(tokenHash: string) {
    const token = this.store.state.tokens.get(tokenHash);
    if (!token) return null;
    const session = this.store.state.sessions.get(token.sessionId);
    if (!session) return null;
    return {
      session: Session.restore(session),
      token: RefreshToken.restore(token),
    };
  }

  /** Mismo contrato que el UPDATE … WHERE used_at IS NULL de Postgres. */
  async markUsed(tokenHash: string, now: Date) {
    const token = this.store.state.tokens.get(tokenHash);
    if (!token || token.usedAt) return false;
    this.store.state.tokens.set(tokenHash, { ...token, usedAt: now });
    return true;
  }

  async issue(token: RefreshToken) {
    this.store.state.tokens.set(token.tokenHash, {
      tokenHash: token.tokenHash,
      sessionId: token.sessionId,
      expiresAt: token.expiresAt,
      usedAt: token.usedAt,
    });
  }

  async revoke(session: Session) {
    const current = this.store.state.sessions.get(session.id);
    if (!current || current.revokedAt) return;
    this.store.state.sessions.set(session.id, { ...current, revokedAt: session.revokedAt, revokedReason: session.revokedReason });
  }

  async revokeAllForUser(userId: string, reason: RevocationReason, now: Date) {
    const revoked: string[] = [];
    for (const [id, s] of this.store.state.sessions) {
      if (s.userId !== userId || s.revokedAt) continue;
      this.store.state.sessions.set(id, { ...s, revokedAt: now, revokedReason: reason });
      revoked.push(id);
    }
    return revoked;
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

/** Hasher determinista: la propiedad que importa en los tests es que distinga bien, no argon2. */
export class FakePasswordHasher implements PasswordHasher {
  dummyVerifications = 0;
  async hash(plain: string) {
    return `hashed:${plain}`;
  }
  async verify(stored: string, plain: string) {
    return stored === `hashed:${plain}`;
  }
  async verifyDummy() {
    this.dummyVerifications += 1;
  }
}

/** Limitador con reloj inyectable, para poder probar el backoff sin esperar minutos reales. */
export class InMemoryAttemptLimiter implements AttemptLimiter {
  private readonly failures = new Map<string, number>();
  private readonly locks = new Map<string, number>();
  constructor(public clock: () => number = Date.now) {}

  async status(key: string): Promise<AttemptStatus> {
    const remaining = (this.locks.get(key) ?? 0) - this.clock();
    return remaining > 0 ? { locked: true, retryAfterSeconds: Math.ceil(remaining / 1_000) } : { locked: false, retryAfterSeconds: 0 };
  }

  async registerFailure(key: string): Promise<AttemptFailure> {
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const durationMs = lockDurationMs(failures);
    if (durationMs === 0) return { failures, lockedUntil: null };
    const until = this.clock() + durationMs;
    this.locks.set(key, until);
    return { failures, lockedUntil: new Date(until) };
  }

  async reset(key: string): Promise<void> {
    this.failures.delete(key);
    this.locks.delete(key);
  }
}

/** role-service de mentira: se le puede "apagar" para probar el fallback y la falla cerrada. */
export class FakeAuthorizationProvider implements AuthorizationProvider {
  available = true;
  calls = 0;
  readonly authorizations = new Map<string, UserAuthorization>();

  async fetch(userId: string): Promise<UserAuthorization> {
    this.calls += 1;
    if (!this.available) throw new Error('role-service no responde');
    return this.authorizations.get(userId) ?? { userId, roles: [], permissions: [] };
  }
}

export class InMemoryAuthorizationCache implements AuthorizationCache {
  readonly entries = new Map<string, UserAuthorization>();
  async find(userId: string) {
    return this.entries.get(userId) ?? null;
  }
  async save(authorization: UserAuthorization) {
    this.entries.set(authorization.userId, authorization);
  }
}

/** Firmante de mentira: devuelve un "token" legible para poder afirmar sobre sus claims. */
export class FakeTokenSigner implements TokenSigner {
  readonly signed: AccessTokenRequest[] = [];
  async signAccessToken(request: AccessTokenRequest): Promise<SignedAccessToken> {
    this.signed.push(request);
    return { token: `access:${request.userId}:${request.sessionId}`, jti: `jti-${this.signed.length}`, expiresInSeconds: 600 };
  }
  async signServiceToken(scope: string) {
    return `service:${scope}`;
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
  dataOf(type: string) {
    return this.published.filter((e) => e.type === type).map((e) => e.data as Record<string, unknown>);
  }
}

export const testSettings = (over: Partial<AuthSettings> = {}): AuthSettings => ({
  issuer: 'http://auth.test',
  accessTokenTtlSeconds: 600,
  refreshTokenTtlSeconds: 7 * 24 * 3_600,
  sessionTtlSeconds: 30 * 24 * 3_600,
  demoPasswords: { admin: 'Admin123!demo', auditor: 'Auditor123!demo', viewer: 'Viewer123!demo' },
  ...over,
});

/** Arma todas las piezas en memoria para un test. */
export function inMemoryContext(clock: () => number = Date.now) {
  const store = new InMemoryStore();
  const provider = new FakeAuthorizationProvider();
  const cache = new InMemoryAuthorizationCache();
  return {
    store,
    uow: new FakeUnitOfWork(store),
    accounts: new InMemoryAccountRepository(store),
    sessions: new InMemorySessionRepository(store),
    processed: new InMemoryProcessedEvents(store),
    hasher: new FakePasswordHasher(),
    limiter: new InMemoryAttemptLimiter(clock),
    provider,
    cache,
    authorization: new AuthorizationResolver(provider, cache),
    tokens: new FakeTokenSigner(),
    bus: new RecordingEventBus(),
    settings: testSettings(),
  };
}
