import { type Actor, createEnvelope, DEMO_USERS, EventDataSchemas, EVENTS, SYSTEM_ROLE_IDS } from '@toka/contracts';
import { inMemoryContext } from '../../test/fakes/in-memory';
import type { DomainError } from '../domain/shared/domain-error';
import { ReactivateUserUseCase, SuspendUserUseCase } from './commands/change-status.use-case';
import { UpdateProfileUseCase } from './commands/update-profile.use-case';
import { type ConsumedEvent, UserEventHandlers } from './events/user-event-handlers';
import { GetUserQuery, GetUserStatsQuery, ListUsersQuery } from './queries/user-queries';

const ADMIN_ID = DEMO_USERS.admin.id;
const AUDITOR_ID = DEMO_USERS.auditor.id;
const VIEWER_ID = DEMO_USERS.viewer.id;
const MISSING = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';
const admin: Actor = { id: ADMIN_ID, type: 'user' };
const ROLE = { admin: { id: SYSTEM_ROLE_IDS.admin, name: 'admin' }, viewer: { id: SYSTEM_ROLE_IDS.viewer, name: 'viewer' } };

const registered = (userId: string, email: string, eventId?: string, extra: Record<string, unknown> = {}): ConsumedEvent =>
  createEnvelope({
    type: EVENTS.ACCOUNT_REGISTERED,
    eventId,
    producer: 'auth-service',
    correlationId: 'corr-12345678',
    subject: { type: 'user', id: userId },
    data: { userId, email, fullName: `Nombre ${email}`, source: 'admin' as const, ...extra },
  });

const assignments = (userId: string, roles: { id: string; name: string }[], assignmentsVersion: number, eventId?: string): ConsumedEvent =>
  createEnvelope({
    type: EVENTS.ROLE_ASSIGNMENTS_CHANGED,
    eventId,
    producer: 'role-service',
    correlationId: 'corr-12345678',
    subject: { type: 'user', id: userId },
    data: { userId, roles, assignmentsVersion },
  });

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as DomainError).code;
  }
};

/** Tres usuarios: admin (admin), auditor y viewer (viewer), todos activos y con su snapshot de roles. */
async function setup() {
  const ctx = inMemoryContext();
  const handlers = new UserEventHandlers(ctx.profiles, ctx.projections, ctx.processed, ctx.uow, ctx.cache);
  for (const u of Object.values(DEMO_USERS)) await handlers.handle(registered(u.id, u.email, undefined, { department: 'TI' }));
  await handlers.handle(assignments(ADMIN_ID, [ROLE.admin], 1));
  await handlers.handle(assignments(AUDITOR_ID, [ROLE.viewer], 1));
  await handlers.handle(assignments(VIEWER_ID, [ROLE.viewer], 1));
  ctx.cache.invalidations = 0;
  return {
    ...ctx,
    handlers,
    update: new UpdateProfileUseCase(ctx.profiles, ctx.projections, ctx.uow, ctx.bus),
    suspend: new SuspendUserUseCase(ctx.profiles, ctx.projections, ctx.uow, ctx.bus, ctx.cache),
    reactivate: new ReactivateUserUseCase(ctx.profiles, ctx.projections, ctx.uow, ctx.bus, ctx.cache),
    list: new ListUsersQuery(ctx.readModel),
    get: new GetUserQuery(ctx.readModel),
    stats: new GetUserStatsQuery(ctx.readModel, ctx.cache),
  };
}

describe('consumidor: account.registered', () => {
  it('crea el perfil con los datos del evento y es idempotente (mismo eventId y mismo usuario)', async () => {
    const t = await setup();
    const event = registered(MISSING, 'nuevo@toka.test', undefined, { department: 'Ventas', jobTitle: 'Ejecutivo' });
    await t.handlers.handle(event);
    expect(await t.get.execute(MISSING)).toMatchObject({ email: 'nuevo@toka.test', department: 'Ventas', jobTitle: 'Ejecutivo', status: 'ACTIVE', version: 1, roles: [] });
    expect(t.cache.invalidations).toBe(1);
    await t.handlers.handle(event); // re-entrega
    await t.handlers.handle(registered(MISSING, 'nuevo@toka.test')); // otro eventId, mismo usuario
    expect((await t.list.execute({ page: 1, pageSize: 50 })).total).toBe(4);
    expect(t.cache.invalidations).toBe(1);
    expect(t.bus.published).toHaveLength(0);
  });

  it('un email que ya tiene otro perfil falla y revierte la marca de procesado (no queda a medias)', async () => {
    const t = await setup();
    const clash = registered(MISSING, DEMO_USERS.admin.email);
    expect(await errorCode(t.handlers.handle(clash))).toBe('EMAIL_TAKEN');
    expect(t.store.state.processed.has(clash.eventId)).toBe(false);
    expect(await t.readModel.get(MISSING)).toBeNull();
  });

  it('un payload que viola el dominio (nombre en blanco) falla con un error de dominio', async () => {
    const t = await setup();
    expect(await errorCode(t.handlers.handle(registered(MISSING, 'x@toka.test', undefined, { fullName: '   ' })))).toBe('INVALID_FULL_NAME');
  });
});

describe('consumidor: role.assignments_changed', () => {
  it('actualiza la proyección aunque el perfil aún no exista (el snapshot puede llegar antes)', async () => {
    const t = await setup();
    await t.handlers.handle(assignments(MISSING, [ROLE.admin], 1));
    expect((await t.projections.get(MISSING)).isAdmin).toBe(true);
    expect(await t.readModel.get(MISSING)).toBeNull();
  });

  it('descarta snapshots viejos o repetidos y es idempotente por eventId', async () => {
    const t = await setup();
    await t.handlers.handle(assignments(VIEWER_ID, [ROLE.admin], 3));
    expect((await t.projections.get(VIEWER_ID)).roles).toEqual(['admin']);
    expect(t.cache.invalidations).toBe(1);
    await t.handlers.handle(assignments(VIEWER_ID, [ROLE.viewer], 2)); // llegó tarde
    await t.handlers.handle(assignments(VIEWER_ID, [ROLE.viewer], 3)); // misma versión
    expect((await t.projections.get(VIEWER_ID)).roles).toEqual(['admin']);
    const replay = assignments(VIEWER_ID, [ROLE.viewer], 4);
    await t.handlers.handle(replay);
    await t.handlers.handle(replay);
    expect((await t.projections.get(VIEWER_ID)).version).toBe(4);
    expect(t.cache.invalidations).toBe(2);
  });
});

describe('UpdateProfileUseCase', () => {
  it('edita, publica user.profile_updated tras el commit y devuelve la vista con roles', async () => {
    const t = await setup();
    const view = await t.update.execute(VIEWER_ID, { version: 1, jobTitle: 'Analista' }, admin);
    expect(view).toMatchObject({ jobTitle: 'Analista', version: 2, roles: ['viewer'] });
    expect(t.bus.types()).toEqual([EVENTS.USER_PROFILE_UPDATED]);
    const [event] = t.bus.published;
    expect(event).toMatchObject({ subject: { type: 'user', id: VIEWER_ID }, actor: admin, data: { changedFields: ['jobTitle'], version: 2 } });
    expect(EventDataSchemas[EVENTS.USER_PROFILE_UPDATED].safeParse(event.data).success).toBe(true);
  });

  it('sin cambios reales no escribe, no sube la versión y no publica', async () => {
    const t = await setup();
    const view = await t.update.execute(VIEWER_ID, { fullName: `Nombre ${DEMO_USERS.viewer.email}` }, admin);
    expect(view.version).toBe(1);
    expect(t.bus.published).toHaveLength(0);
  });

  it('versión vieja → VERSION_CONFLICT y no publica; usuario inexistente → USER_NOT_FOUND', async () => {
    const t = await setup();
    await t.update.execute(VIEWER_ID, { version: 1, department: 'Ventas' }, admin);
    t.bus.published = [];
    expect(await errorCode(t.update.execute(VIEWER_ID, { version: 1, department: 'Otra' }, admin))).toBe('VERSION_CONFLICT');
    expect(t.bus.published).toHaveLength(0);
    expect(await errorCode(t.update.execute(MISSING, { fullName: 'X' }, admin))).toBe('USER_NOT_FOUND');
  });

  it('un valor inválido falla sin tocar la base', async () => {
    const t = await setup();
    expect(await errorCode(t.update.execute(VIEWER_ID, { fullName: ' ' }, admin))).toBe('INVALID_FULL_NAME');
    expect((await t.get.execute(VIEWER_ID)).version).toBe(1);
  });
});

describe('SuspendUserUseCase', () => {
  it('suspende, publica user.status_changed con la versión del agregado y toma el lock de admins', async () => {
    const t = await setup();
    const view = await t.suspend.execute(VIEWER_ID, { reason: 'baja' }, admin);
    expect(view).toMatchObject({ status: 'SUSPENDED', statusReason: 'baja', version: 2 });
    expect(t.store.locks).toBe(1);
    expect(t.cache.invalidations).toBe(1);
    const [event] = t.bus.published;
    expect(event).toMatchObject({ type: EVENTS.USER_STATUS_CHANGED, data: { status: 'SUSPENDED', previousStatus: 'ACTIVE', reason: 'baja', version: 2 } });
    expect(EventDataSchemas[EVENTS.USER_STATUS_CHANGED].safeParse(event.data).success).toBe(true);
  });

  it('nadie se suspende a sí mismo: se compara con la base, aunque el cliente mande otra cosa', async () => {
    const t = await setup();
    expect(await errorCode(t.suspend.execute(ADMIN_ID, {}, admin))).toBe('SELF_SUSPENSION');
    expect(await errorCode(t.suspend.execute(VIEWER_ID, {}, { id: VIEWER_ID, type: 'user' }))).toBe('SELF_SUSPENSION');
    expect(t.bus.published).toHaveLength(0);
  });

  it('LAST_ADMIN: no se suspende al único admin activo (lo hace otro usuario)', async () => {
    const t = await setup();
    expect(await errorCode(t.suspend.execute(ADMIN_ID, {}, { id: AUDITOR_ID, type: 'user' }))).toBe('LAST_ADMIN');
    expect((await t.get.execute(ADMIN_ID)).status).toBe('ACTIVE');
    expect(t.bus.published).toHaveLength(0);
  });

  it('con dos admins se puede suspender a uno, pero entonces el otro queda protegido', async () => {
    const t = await setup();
    await t.handlers.handle(assignments(AUDITOR_ID, [ROLE.admin], 2));
    await t.suspend.execute(AUDITOR_ID, {}, admin);
    expect(await errorCode(t.suspend.execute(ADMIN_ID, {}, { id: VIEWER_ID, type: 'user' }))).toBe('LAST_ADMIN');
  });

  it('reactivar a un admin le devuelve el margen: otra vez hay dos admins activos', async () => {
    const t = await setup();
    await t.handlers.handle(assignments(AUDITOR_ID, [ROLE.admin], 2));
    await t.suspend.execute(AUDITOR_ID, {}, admin);
    await t.reactivate.execute(AUDITOR_ID, {}, admin);
    expect(await errorCode(t.suspend.execute(ADMIN_ID, {}, { id: VIEWER_ID, type: 'user' }))).toBe('ok');
  });

  it('ya suspendido, inexistente y versión vieja se rechazan sin publicar', async () => {
    const t = await setup();
    await t.suspend.execute(VIEWER_ID, {}, admin);
    t.bus.published = [];
    expect(await errorCode(t.suspend.execute(VIEWER_ID, {}, admin))).toBe('ALREADY_SUSPENDED');
    expect(await errorCode(t.suspend.execute(MISSING, {}, admin))).toBe('USER_NOT_FOUND');
    expect(await errorCode(t.suspend.execute(AUDITOR_ID, { version: 9 }, admin))).toBe('VERSION_CONFLICT');
    expect(t.bus.published).toHaveLength(0);
  });
});

describe('ReactivateUserUseCase', () => {
  it('reactiva y publica user.status_changed con la versión siguiente', async () => {
    const t = await setup();
    await t.suspend.execute(VIEWER_ID, { reason: 'baja' }, admin);
    t.bus.published = [];
    const view = await t.reactivate.execute(VIEWER_ID, { version: 2, reason: 'regresó' }, admin);
    expect(view).toMatchObject({ status: 'ACTIVE', statusReason: null, version: 3 });
    expect(t.bus.published[0]).toMatchObject({ type: EVENTS.USER_STATUS_CHANGED, data: { status: 'ACTIVE', previousStatus: 'SUSPENDED', reason: 'regresó', version: 3 } });
  });

  it('activo, inexistente o versión vieja → error sin publicar', async () => {
    const t = await setup();
    expect(await errorCode(t.reactivate.execute(VIEWER_ID, {}, admin))).toBe('ALREADY_ACTIVE');
    expect(await errorCode(t.reactivate.execute(MISSING, {}, admin))).toBe('USER_NOT_FOUND');
    await t.suspend.execute(VIEWER_ID, {}, admin);
    expect(await errorCode(t.reactivate.execute(VIEWER_ID, { version: 1 }, admin))).toBe('VERSION_CONFLICT');
  });
});

describe('consultas', () => {
  it('lista paginada con búsqueda (nombre o email, sin distinguir mayúsculas) y filtro por estado', async () => {
    const t = await setup();
    await t.suspend.execute(VIEWER_ID, {}, admin);
    const all = await t.list.execute({ page: 1, pageSize: 2 });
    expect(all).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(all.items).toHaveLength(2);
    expect((await t.list.execute({ page: 2, pageSize: 2 })).items).toHaveLength(1);
    expect((await t.list.execute({ page: 1, pageSize: 10, search: 'AUDITOR@' })).items.map((u) => u.id)).toEqual([AUDITOR_ID]);
    expect((await t.list.execute({ page: 1, pageSize: 10, status: 'SUSPENDED' })).items.map((u) => u.id)).toEqual([VIEWER_ID]);
    expect((await t.list.execute({ page: 1, pageSize: 10, status: 'ACTIVE', search: 'viewer' })).total).toBe(0);
  });

  it('get: devuelve el perfil con sus roles o USER_NOT_FOUND', async () => {
    const t = await setup();
    expect(await t.get.execute(ADMIN_ID)).toMatchObject({ roles: ['admin'], department: 'TI' });
    expect(await errorCode(t.get.execute(MISSING))).toBe('USER_NOT_FOUND');
  });

  it('stats: cuenta por estado y rol (solo activos), y usa la cache hasta que algo la invalida', async () => {
    const t = await setup();
    const first = await t.stats.execute();
    expect(first).toMatchObject({ total: 3, active: 3, suspended: 0, activeAdmins: 1, newLast7Days: 3 });
    expect(first.byRole).toEqual([{ role: 'admin', count: 1 }, { role: 'viewer', count: 2 }]);
    expect(await t.stats.execute()).toBe(first);
    expect(t.cache.hits).toBe(1);
    await t.suspend.execute(VIEWER_ID, {}, admin);
    const after = await t.stats.execute();
    expect(after).toMatchObject({ active: 2, suspended: 1 });
    expect(after.byRole).toEqual([{ role: 'admin', count: 1 }, { role: 'viewer', count: 1 }]);
  });
});
