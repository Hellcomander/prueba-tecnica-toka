import { type Actor, createEnvelope, DEMO_USERS, EVENTS, SYSTEM_ROLES } from '@toka/contracts';
import { inMemoryContext } from '../../test/fakes/in-memory';
import { sha256Hex } from '../domain/shared/hashing';
import type { DomainError } from '../domain/shared/domain-error';
import { TooManyAttemptsError } from '../domain/shared/domain-error';
import { CreateAccountUseCase } from './commands/create-account.use-case';
import { LoginUseCase } from './commands/login.use-case';
import { LogoutUseCase } from './commands/logout.use-case';
import { RefreshUseCase } from './commands/refresh.use-case';
import { SeedAccountsUseCase } from './commands/seed-accounts.use-case';
import { AccountNotYetKnownError, AuthEventHandlers, type ConsumedEvent } from './events/auth-event-handlers';
import { DiscoveryQuery, UserInfoQuery } from './queries/auth-queries';

const ADMIN = DEMO_USERS.admin;
const VIEWER = DEMO_USERS.viewer;
const ADMIN_PASSWORD = 'Admin123!demo';
const admin: Actor = { id: ADMIN.id, type: 'user' };
const ctxOf = (ip = '10.0.0.1') => ({ ip, userAgent: 'jest' });

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as DomainError).code;
  }
};

const errorKind = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as DomainError).kind;
  }
};

async function setup(clock: () => number = Date.now) {
  const ctx = inMemoryContext(clock);
  const seed = new SeedAccountsUseCase(ctx.accounts, ctx.hasher, ctx.uow, ctx.bus, ctx.settings);
  const useCases = {
    seed,
    login: new LoginUseCase(ctx.accounts, ctx.sessions, ctx.hasher, ctx.limiter, ctx.authorization, ctx.tokens, ctx.uow, ctx.bus, ctx.settings),
    refresh: new RefreshUseCase(ctx.accounts, ctx.sessions, ctx.authorization, ctx.tokens, ctx.uow, ctx.bus, ctx.settings),
    logout: new LogoutUseCase(ctx.sessions, ctx.uow, ctx.bus),
    createAccount: new CreateAccountUseCase(ctx.accounts, ctx.hasher, ctx.uow, ctx.bus),
    handlers: new AuthEventHandlers(ctx.accounts, ctx.sessions, ctx.processed, ctx.uow),
    userInfo: new UserInfoQuery(ctx.accounts),
  };
  await seed.execute({ demoUsers: true });
  ctx.provider.authorizations.set(ADMIN.id, { userId: ADMIN.id, roles: ['admin'], permissions: [...SYSTEM_ROLES.admin] });
  ctx.provider.authorizations.set(VIEWER.id, { userId: VIEWER.id, roles: ['viewer'], permissions: [...SYSTEM_ROLES.viewer] });
  ctx.bus.published = [];
  return { ...ctx, ...useCases };
}

const statusChanged = (userId: string, status: 'ACTIVE' | 'SUSPENDED', version: number, eventId?: string): ConsumedEvent =>
  createEnvelope({
    type: EVENTS.USER_STATUS_CHANGED,
    eventId,
    producer: 'user-service',
    correlationId: 'corr-12345678',
    subject: { type: 'user', id: userId },
    data: {
      userId,
      status,
      previousStatus: (status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE') as 'ACTIVE' | 'SUSPENDED',
      version,
    },
  });

describe('siembra de cuentas demo', () => {
  it('crea las tres cuentas con sus ids fijos, publica account.registered y es idempotente', async () => {
    const ctx = inMemoryContext();
    const seed = new SeedAccountsUseCase(ctx.accounts, ctx.hasher, ctx.uow, ctx.bus, ctx.settings);
    expect(await seed.execute({ demoUsers: true })).toEqual({ createdAccounts: [ADMIN.email, DEMO_USERS.auditor.email, VIEWER.email] });
    expect(ctx.bus.types()).toEqual([EVENTS.ACCOUNT_REGISTERED, EVENTS.ACCOUNT_REGISTERED, EVENTS.ACCOUNT_REGISTERED]);
    expect(ctx.bus.dataOf(EVENTS.ACCOUNT_REGISTERED)[0]).toMatchObject({ userId: ADMIN.id, email: ADMIN.email, source: 'seed' });
    // La contraseña sale de la configuración, no del dominio, y en base queda solo su hash.
    expect((await ctx.accounts.findById(ADMIN.id))?.passwordHash).toBe(`hashed:${ADMIN_PASSWORD}`);

    ctx.bus.published = [];
    expect(await seed.execute({ demoUsers: true })).toEqual({ createdAccounts: [] });
    expect(await seed.execute({ demoUsers: false })).toEqual({ createdAccounts: [] });
    expect(ctx.bus.published).toHaveLength(0);
  });
});

describe('login', () => {
  it('entrega access token, refresh opaco y publica auth.login_succeeded con el email hasheado', async () => {
    const t = await setup();
    const result = await t.login.execute({ email: 'Admin@Toka.local', password: ADMIN_PASSWORD }, ctxOf());

    expect(result.accessToken).toContain(`access:${ADMIN.id}`);
    expect(result.user).toMatchObject({ id: ADMIN.id, email: ADMIN.email, roles: ['admin'] });
    expect(result.user.permissions).toContain('users:write');
    expect(t.tokens.signed[0]).toMatchObject({ sessionId: result.user.sessionId, roles: ['admin'] });

    // El refresh en claro no se guarda en ningún lado: en base solo está su SHA-256.
    expect(t.store.state.tokens.has(sha256Hex(result.refreshToken))).toBe(true);
    expect([...t.store.state.tokens.keys()]).not.toContain(result.refreshToken);

    expect(t.bus.types()).toEqual([EVENTS.AUTH_LOGIN_SUCCEEDED]);
    expect(t.bus.dataOf(EVENTS.AUTH_LOGIN_SUCCEEDED)[0]).toEqual({
      userId: ADMIN.id,
      sid: result.user.sessionId,
      emailHash: sha256Hex(ADMIN.email),
      ip: '10.0.0.1',
      userAgent: 'jest',
    });
  });

  it('credenciales malas y correo inexistente dan el mismo error, y el inexistente paga el hash dummy', async () => {
    const t = await setup();
    expect(await errorCode(t.login.execute({ email: ADMIN.email, password: 'Equivocada1234' }, ctxOf()))).toBe('INVALID_CREDENTIALS');
    expect(await errorCode(t.login.execute({ email: 'nadie@toka.local', password: 'Equivocada1234' }, ctxOf()))).toBe('INVALID_CREDENTIALS');
    expect(t.hasher.dummyVerifications).toBe(1);

    const failures = t.bus.dataOf(EVENTS.AUTH_LOGIN_FAILED);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ userId: ADMIN.id, reason: 'invalid_credentials', emailHash: sha256Hex(ADMIN.email) });
    // De un correo que no existe no se puede reportar userId: null, y el email va hasheado.
    expect(failures[1]).toMatchObject({ userId: null, reason: 'invalid_credentials', emailHash: sha256Hex('nadie@toka.local') });
  });

  it('una cuenta suspendida no entra, aunque la contraseña sea correcta', async () => {
    const t = await setup();
    await t.handlers.handle(statusChanged(ADMIN.id, 'SUSPENDED', 1));
    expect(await errorCode(t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf()))).toBe('ACCOUNT_DISABLED');
    expect(await errorKind(t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf()))).toBe('forbidden');
    expect(t.bus.dataOf(EVENTS.AUTH_LOGIN_FAILED)[0]).toMatchObject({ userId: ADMIN.id, reason: 'account_disabled' });
  });

  it('el login exitoso borra el contador de fallos previos', async () => {
    const t = await setup();
    await errorCode(t.login.execute({ email: ADMIN.email, password: 'Equivocada1234' }, ctxOf()));
    await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    expect(await t.limiter.status(`${sha256Hex(ADMIN.email)}:10.0.0.1`)).toEqual({ locked: false, retryAfterSeconds: 0 });
  });
});

describe('lockout por fuerza bruta', () => {
  it('al quinto fallo bloquea con 429, publica auth.account_locked y el backoff crece', async () => {
    let now = Date.parse('2026-03-01T12:00:00.000Z');
    const t = await setup(() => now);
    const attempt = () => t.login.execute({ email: ADMIN.email, password: 'Equivocada1234' }, ctxOf());

    for (let i = 0; i < 5; i += 1) expect(await errorCode(attempt())).toBe('INVALID_CREDENTIALS');
    expect(t.bus.dataOf(EVENTS.AUTH_ACCOUNT_LOCKED)).toHaveLength(1);
    expect(t.bus.dataOf(EVENTS.AUTH_ACCOUNT_LOCKED)[0]).toMatchObject({ emailHash: sha256Hex(ADMIN.email), ip: '10.0.0.1' });

    const locked = await attempt().catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(TooManyAttemptsError);
    expect((locked as TooManyAttemptsError).retryAfterSeconds).toBe(60);
    // Estando bloqueado ni siquiera se mira la contraseña: la buena también rebota.
    await expect(t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf())).rejects.toBeInstanceOf(TooManyAttemptsError);
    expect(t.bus.dataOf(EVENTS.AUTH_LOGIN_FAILED).filter((d) => d.reason === 'locked')).toHaveLength(2);

    // Pasado el minuto, un fallo más bloquea el doble de tiempo.
    now += 61_000;
    expect(await errorCode(attempt())).toBe('INVALID_CREDENTIALS');
    const again = (await attempt().catch((e: unknown) => e)) as TooManyAttemptsError;
    expect(again.retryAfterSeconds).toBe(120);
  });

  it('el bloqueo es por (email, IP): otra IP sigue pudiendo intentar con ese mismo correo', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) await errorCode(t.login.execute({ email: ADMIN.email, password: 'Equivocada1234' }, ctxOf('10.0.0.1')));
    await expect(t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf('10.0.0.1'))).rejects.toBeInstanceOf(TooManyAttemptsError);
    // Si la llave fuera solo el email, aquí el admin estaría fuera de su propia cuenta.
    await expect(t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf('10.0.0.2'))).resolves.toMatchObject({ user: { id: ADMIN.id } });
  });
});

describe('S1: autorización contra role-service', () => {
  it('cuando role-service no responde se usa la copia stale', async () => {
    const t = await setup();
    await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    expect(t.cache.entries.get(ADMIN.id)).toMatchObject({ roles: ['admin'] });

    t.provider.available = false;
    const result = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    expect(result.user.roles).toEqual(['admin']);
    expect(result.user.permissions).toContain('users:write');
  });

  it('sin copia stale falla cerrado con 503: nunca emite un token sin permisos', async () => {
    const t = await setup();
    t.provider.available = false;
    expect(await errorCode(t.login.execute({ email: VIEWER.email, password: 'Viewer123!demo' }, ctxOf()))).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(await errorKind(t.login.execute({ email: VIEWER.email, password: 'Viewer123!demo' }, ctxOf()))).toBe('unavailable');
    // Y no quedó ninguna sesión abierta a medias.
    expect(t.store.state.sessions.size).toBe(0);
  });

  it('el refresh también consulta S1, así que un permiso nuevo entra en el token siguiente', async () => {
    const t = await setup();
    const first = await t.login.execute({ email: VIEWER.email, password: 'Viewer123!demo' }, ctxOf());
    expect(first.user.permissions).not.toContain('audit:read');

    t.provider.authorizations.set(VIEWER.id, { userId: VIEWER.id, roles: ['auditor'], permissions: [...SYSTEM_ROLES.auditor] });
    const rotated = await t.refresh.execute(first.refreshToken);
    expect(rotated.user.roles).toEqual(['auditor']);
    expect(rotated.user.permissions).toContain('audit:read');
  });
});

describe('rotación del refresh', () => {
  it('cada uso entrega un token nuevo dentro de la misma sesión y el anterior deja de servir', async () => {
    const t = await setup();
    const first = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    const second = await t.refresh.execute(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.user.sessionId).toBe(first.user.sessionId);
    expect(await errorCode(t.refresh.execute(first.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
  });

  it('reusar un refresh ya rotado revoca la familia entera y avisa a la auditoría', async () => {
    const t = await setup();
    const first = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    const second = await t.refresh.execute(first.refreshToken);
    t.bus.published = [];

    // El ladrón (o la víctima) presenta el token viejo: es la señal de robo.
    expect(await errorCode(t.refresh.execute(first.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
    expect(t.bus.types()).toEqual([EVENTS.AUTH_LOGOUT]);
    expect(t.bus.dataOf(EVENTS.AUTH_LOGOUT)[0]).toMatchObject({ userId: ADMIN.id, sid: first.user.sessionId, reason: 'refresh_reuse' });

    // Y el token "bueno" tampoco sobrevive: la sesión entera murió, ambos deben volver a entrar.
    expect(await errorCode(t.refresh.execute(second.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
    expect(t.store.state.sessions.get(first.user.sessionId)?.revokedReason).toBe('refresh_reuse');
  });

  it('token desconocido, vacío o de una cuenta suspendida: 401/403 sin filtrar el motivo', async () => {
    const t = await setup();
    expect(await errorCode(t.refresh.execute(null))).toBe('INVALID_REFRESH_TOKEN');
    expect(await errorCode(t.refresh.execute('token-inventado'))).toBe('INVALID_REFRESH_TOKEN');
    expect(await errorKind(t.refresh.execute('token-inventado'))).toBe('unauthorized');

    const session = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    await t.handlers.handle(statusChanged(ADMIN.id, 'SUSPENDED', 1));
    expect(await errorCode(t.refresh.execute(session.refreshToken))).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('logout', () => {
  it('revoca la sesión, publica auth.logout y es idempotente', async () => {
    const t = await setup();
    const session = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    t.bus.published = [];

    await t.logout.execute(session.refreshToken);
    expect(t.bus.dataOf(EVENTS.AUTH_LOGOUT)[0]).toMatchObject({ userId: ADMIN.id, sid: session.user.sessionId, reason: 'user_request' });
    expect(await errorCode(t.refresh.execute(session.refreshToken))).toBe('INVALID_REFRESH_TOKEN');

    // Repetirlo (o mandar basura) no falla ni vuelve a publicar: no sirve para sondear sesiones ajenas.
    await t.logout.execute(session.refreshToken);
    await t.logout.execute('no-existe');
    await t.logout.execute(null);
    expect(t.bus.dataOf(EVENTS.AUTH_LOGOUT)).toHaveLength(1);
  });
});

describe('alta de cuentas', () => {
  it('crea la cuenta, publica account.registered con el perfil y rechaza duplicados', async () => {
    const t = await setup();
    const created = await t.createAccount.execute({ email: ' Nueva@Toka.local ', password: 'Nueva123!demo', fullName: 'Nora Nueva', jobTitle: 'QA' }, admin);

    expect(created).toMatchObject({ email: 'nueva@toka.local', status: 'ACTIVE' });
    expect(t.bus.dataOf(EVENTS.ACCOUNT_REGISTERED)[0]).toMatchObject({
      userId: created.id,
      email: 'nueva@toka.local',
      fullName: 'Nora Nueva',
      jobTitle: 'QA',
      department: null,
      source: 'admin',
    });
    expect(t.bus.published[0].actor).toEqual(admin);

    expect(await errorCode(t.createAccount.execute({ email: 'nueva@toka.local', password: 'Otra123!demo', fullName: 'Otra' }, admin))).toBe('EMAIL_TAKEN');
    expect(await errorCode(t.createAccount.execute({ email: 'x@toka.local', password: 'corta', fullName: 'X' }, admin))).toBe('WEAK_PASSWORD');
    expect(await errorCode(t.createAccount.execute({ email: 'no-es-email', password: 'Buena123!demo', fullName: 'X' }, admin))).toBe('INVALID_EMAIL');
  });

  it('la cuenta recién creada puede entrar', async () => {
    const t = await setup();
    const created = await t.createAccount.execute({ email: 'nueva@toka.local', password: 'Nueva123!demo', fullName: 'Nora' }, admin);
    await expect(t.login.execute({ email: 'nueva@toka.local', password: 'Nueva123!demo' }, ctxOf())).resolves.toMatchObject({
      user: { id: created.id, roles: [], permissions: [] },
    });
  });
});

describe('consumidor de user.status_changed', () => {
  it('suspender cierra las sesiones abiertas y es idempotente', async () => {
    const t = await setup();
    const session = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    const event = statusChanged(ADMIN.id, 'SUSPENDED', 1, '11111111-1111-4111-8111-111111111111');

    await t.handlers.handle(event);
    await t.handlers.handle(event);

    expect((await t.accounts.findById(ADMIN.id))?.isActive).toBe(false);
    expect(t.store.state.sessions.get(session.user.sessionId)?.revokedReason).toBe('user_suspended');
    expect(t.store.state.processed.size).toBe(1);
  });

  it('descarta eventos más viejos que el último aplicado y reactiva con uno más nuevo', async () => {
    const t = await setup();
    await t.handlers.handle(statusChanged(ADMIN.id, 'SUSPENDED', 3));
    await t.handlers.handle(statusChanged(ADMIN.id, 'ACTIVE', 2));
    expect((await t.accounts.findById(ADMIN.id))?.isActive).toBe(false);

    await t.handlers.handle(statusChanged(ADMIN.id, 'ACTIVE', 4));
    expect((await t.accounts.findById(ADMIN.id))?.isActive).toBe(true);
    await expect(t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf())).resolves.toBeDefined();
  });

  it('si la cuenta todavía no existe lanza para reintentar y deja el evento sin marcar', async () => {
    const t = await setup();
    const unknown = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';
    await expect(t.handlers.handle(statusChanged(unknown, 'SUSPENDED', 1))).rejects.toBeInstanceOf(AccountNotYetKnownError);
    expect(t.store.state.processed.size).toBe(0);
  });
});

describe('userinfo y discovery', () => {
  it('userinfo devuelve los datos del token y rebota si la cuenta murió o se suspendió', async () => {
    const t = await setup();
    const session = await t.login.execute({ email: ADMIN.email, password: ADMIN_PASSWORD }, ctxOf());
    const claims = { ...session.user, sessionId: session.user.sessionId };

    expect(await t.userInfo.execute(claims)).toMatchObject({ id: ADMIN.id, email: ADMIN.email, roles: ['admin'] });
    expect(await errorCode(t.userInfo.execute({ ...claims, id: '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10' }))).toBe('ACCOUNT_NOT_FOUND');

    await t.handlers.handle(statusChanged(ADMIN.id, 'SUSPENDED', 1));
    expect(await errorCode(t.userInfo.execute(claims))).toBe('ACCOUNT_DISABLED');
  });

  it('el discovery solo anuncia lo que existe de verdad', async () => {
    const discovery = new DiscoveryQuery({
      issuer: 'http://auth-service:3001/',
      accessTokenTtlSeconds: 600,
      refreshTokenTtlSeconds: 1,
      sessionTtlSeconds: 1,
      demoPasswords: { admin: 'x', auditor: 'y', viewer: 'z' },
    }).execute();

    expect(discovery).toMatchObject({
      issuer: 'http://auth-service:3001',
      jwks_uri: 'http://auth-service:3001/.well-known/jwks.json',
      userinfo_endpoint: 'http://auth-service:3001/api/v1/auth/userinfo',
      id_token_signing_alg_values_supported: ['RS256'],
    });
    // No se implementan los flujos de OAuth 2.0: anunciarlos rompería a un cliente OIDC genérico.
    expect(discovery.token_endpoint).toBeUndefined();
    expect(discovery.authorization_endpoint).toBeUndefined();
  });
});
