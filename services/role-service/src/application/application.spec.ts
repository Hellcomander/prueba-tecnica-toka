import { type Actor, createEnvelope, DEMO_USERS, EVENTS, SYSTEM_ROLE_IDS } from '@toka/contracts';
import { inMemoryContext } from '../../test/fakes/in-memory';
import type { DomainError } from '../domain/shared/domain-error';
import { CreateRoleUseCase } from './commands/create-role.use-case';
import { DeleteRoleUseCase } from './commands/delete-role.use-case';
import { ReplaceUserRolesUseCase } from './commands/replace-user-roles.use-case';
import { SeedRolesUseCase } from './commands/seed-roles.use-case';
import { UpdateRoleUseCase } from './commands/update-role.use-case';
import { type ConsumedEvent, RoleEventHandlers, UserNotYetKnownError } from './events/role-event-handlers';
import { GetAuthorizationQuery, GetRoleQuery, GetUserRolesQuery, ListPermissionsQuery, ListRolesQuery } from './queries/role-queries';

const ADMIN_ID = DEMO_USERS.admin.id;
const admin: Actor = { id: ADMIN_ID, type: 'user' };
const NEW_USER = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';

async function setup() {
  const ctx = inMemoryContext();
  const deps = [ctx.roles, ctx.access, ctx.directory, ctx.uow, ctx.bus] as const;
  const useCases = {
    seed: new SeedRolesUseCase(...deps),
    create: new CreateRoleUseCase(ctx.roles, ctx.uow, ctx.bus),
    update: new UpdateRoleUseCase(ctx.roles, ctx.access, ctx.uow, ctx.bus),
    remove: new DeleteRoleUseCase(ctx.roles, ctx.uow, ctx.bus),
    replace: new ReplaceUserRolesUseCase(...deps),
    handlers: new RoleEventHandlers(ctx.roles, ctx.access, ctx.directory, ctx.processed, ctx.uow, ctx.bus),
    listRoles: new ListRolesQuery(ctx.roles),
    getRole: new GetRoleQuery(ctx.roles),
    userRoles: new GetUserRolesQuery(ctx.roles, ctx.access),
    authz: new GetAuthorizationQuery(ctx.roles, ctx.access),
  };
  await useCases.seed.execute({ demoUsers: true });
  ctx.bus.published = [];
  return { ...ctx, ...useCases };
}

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as DomainError).code;
  }
};

const registered = (userId = NEW_USER, eventId?: string): ConsumedEvent =>
  createEnvelope({
    type: EVENTS.ACCOUNT_REGISTERED,
    eventId,
    producer: 'auth-service',
    correlationId: 'corr-12345678',
    subject: { type: 'user', id: userId },
    data: { userId, email: 'nuevo@toka.test', fullName: 'Nuevo', source: 'admin' as const },
  });

const statusChanged = (userId: string, status: 'ACTIVE' | 'SUSPENDED', version: number): ConsumedEvent =>
  createEnvelope({
    type: EVENTS.USER_STATUS_CHANGED,
    producer: 'user-service',
    correlationId: 'corr-12345678',
    subject: { type: 'user', id: userId },
    data: { userId, status, previousStatus: (status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE') as 'ACTIVE' | 'SUSPENDED', version },
  });

describe('siembra', () => {
  it('crea los roles de sistema y asigna los usuarios demo una sola vez (idempotente)', async () => {
    const t = await setup();
    expect((await t.listRoles.execute()).map((r) => r.name)).toEqual(['admin', 'auditor', 'viewer']);
    expect(await t.authz.execute(ADMIN_ID)).toMatchObject({ roles: ['admin'] });
    expect((await t.authz.execute(ADMIN_ID)).permissions).toContain('roles:assign');
    expect(await t.seed.execute({ demoUsers: true })).toEqual({ createdRoles: [], assignedUsers: [] });
    expect(t.bus.published).toHaveLength(0);
  });

  it('sin modo demo solo crea roles', async () => {
    const t = inMemoryContext();
    const seed = new SeedRolesUseCase(t.roles, t.access, t.directory, t.uow, t.bus);
    expect(await seed.execute({ demoUsers: false })).toEqual({ createdRoles: ['admin', 'auditor', 'viewer'], assignedUsers: [] });
  });
});

describe('CRUD de roles', () => {
  it('crea, consulta, edita con versión y elimina un rol propio, publicando eventos', async () => {
    const t = await setup();
    const role = await t.create.execute({ name: 'Soporte', description: ' Mesa de ayuda ', permissions: ['users:read'] }, admin);
    expect(role).toMatchObject({ name: 'soporte', description: 'Mesa de ayuda', version: 1, isSystem: false });
    expect((await t.getRole.execute(role.id)).name).toBe('soporte');

    const updated = await t.update.execute(role.id, { version: 1, permissions: ['users:read', 'audit:read'] }, admin);
    expect(updated.version).toBe(2);
    expect(await errorCode(t.update.execute(role.id, { version: 1, description: 'x' }, admin))).toBe('VERSION_CONFLICT');

    await t.remove.execute(role.id, admin);
    expect(await errorCode(t.getRole.execute(role.id))).toBe('ROLE_NOT_FOUND');
    expect(t.bus.types()).toEqual([EVENTS.ROLE_CREATED, EVENTS.ROLE_UPDATED, EVENTS.ROLE_DELETED]);
    expect(t.bus.published[0].actor).toEqual(admin);
  });

  it('rechaza nombres repetidos, permisos inexistentes y cambios a roles de sistema', async () => {
    const t = await setup();
    expect(await errorCode(t.create.execute({ name: 'admin', permissions: ['users:read'] }, admin))).toBe('ROLE_NAME_TAKEN');
    expect(await errorCode(t.create.execute({ name: 'otro', permissions: ['users:delete'] }, admin))).toBe('UNKNOWN_PERMISSION');
    expect(await errorCode(t.update.execute(SYSTEM_ROLE_IDS.viewer, { version: 1, description: 'x' }, admin))).toBe('SYSTEM_ROLE_IMMUTABLE');
    expect(await errorCode(t.update.execute('no-existe', { version: 1 }, admin))).toBe('ROLE_NOT_FOUND');
    expect(await errorCode(t.update.execute(SYSTEM_ROLE_IDS.viewer, { version: 1, permissions: ['nope'] }, admin))).toBe('UNKNOWN_PERMISSION');
    const soporte = await t.create.execute({ name: 'soporte', permissions: ['users:read'] }, admin);
    expect(await errorCode(t.update.execute(soporte.id, { version: 1, name: 'auditor' }, admin))).toBe('ROLE_NAME_TAKEN');
    expect(await errorCode(t.remove.execute(SYSTEM_ROLE_IDS.viewer, admin))).toBe('SYSTEM_ROLE_IMMUTABLE');
    expect(await errorCode(t.remove.execute('no-existe', admin))).toBe('ROLE_NOT_FOUND');
    expect(new ListPermissionsQuery().execute()).toContainEqual({ code: 'audit:read', description: 'Consultar la auditoría' });
  });

  it('renombrar un rol re-emite el snapshot de cada miembro; un rol con miembros no se borra', async () => {
    const t = await setup();
    const soporte = await t.create.execute({ name: 'soporte', permissions: ['users:read'] }, admin);
    await t.replace.execute(DEMO_USERS.viewer.id, { roleIds: [SYSTEM_ROLE_IDS.viewer, soporte.id] }, admin);
    t.bus.published = [];

    await t.update.execute(soporte.id, { version: 1, name: 'soporte-n1' }, admin);
    expect(t.bus.types()).toEqual([EVENTS.ROLE_UPDATED, EVENTS.ROLE_ASSIGNMENTS_CHANGED]);
    expect(t.bus.published[1].data).toMatchObject({ userId: DEMO_USERS.viewer.id, roles: [{ name: 'soporte-n1' }, { name: 'viewer' }] });
    expect(await errorCode(t.remove.execute(soporte.id, admin))).toBe('ROLE_IN_USE');
  });
});

describe('asignación de roles', () => {
  it('reemplaza roles bajo lock, publica el snapshot y la autorización refleja el cambio', async () => {
    const t = await setup();
    const view = await t.replace.execute(DEMO_USERS.viewer.id, { roleIds: [SYSTEM_ROLE_IDS.auditor], assignmentsVersion: 1 }, admin);
    expect(view).toEqual({ userId: DEMO_USERS.viewer.id, roles: [{ id: SYSTEM_ROLE_IDS.auditor, name: 'auditor' }], assignmentsVersion: 2 });
    expect(t.store.locks).toContain(SYSTEM_ROLE_IDS.admin);
    expect(t.bus.published[0]).toMatchObject({ type: EVENTS.ROLE_ASSIGNMENTS_CHANGED, data: { assignmentsVersion: 2 } });
    expect((await t.authz.execute(DEMO_USERS.viewer.id)).permissions).toContain('audit:read');
    expect(await t.userRoles.execute(DEMO_USERS.viewer.id)).toEqual(view);
  });

  it('sin cambios no publica; versión vieja → 409; usuario o rol inexistente → 404/422', async () => {
    const t = await setup();
    await t.replace.execute(DEMO_USERS.viewer.id, { roleIds: [SYSTEM_ROLE_IDS.viewer] }, admin);
    expect(t.bus.published).toHaveLength(0);
    expect(await errorCode(t.replace.execute(DEMO_USERS.viewer.id, { roleIds: [], assignmentsVersion: 0 }, admin))).toBe('VERSION_CONFLICT');
    expect(await errorCode(t.replace.execute(NEW_USER, { roleIds: [SYSTEM_ROLE_IDS.viewer] }, admin))).toBe('USER_NOT_FOUND');
    expect(await errorCode(t.replace.execute(DEMO_USERS.viewer.id, { roleIds: ['rol-fantasma'] }, admin))).toBe('UNKNOWN_ROLE');
  });

  it('el último admin activo no pierde el rol; con un segundo admin sí; nadie se lo quita a sí mismo', async () => {
    const t = await setup();
    const auditorActor: Actor = { id: DEMO_USERS.auditor.id, type: 'user' };
    expect(await errorCode(t.replace.execute(ADMIN_ID, { roleIds: [SYSTEM_ROLE_IDS.viewer] }, auditorActor))).toBe('LAST_ADMIN');
    expect(await errorCode(t.replace.execute(ADMIN_ID, { roleIds: [SYSTEM_ROLE_IDS.viewer] }, admin))).toBe('SELF_ADMIN_REMOVAL');

    await t.replace.execute(DEMO_USERS.auditor.id, { roleIds: [SYSTEM_ROLE_IDS.admin] }, admin);
    await expect(t.replace.execute(ADMIN_ID, { roleIds: [SYSTEM_ROLE_IDS.viewer] }, auditorActor)).resolves.toMatchObject({
      roles: [{ name: 'viewer' }],
    });
  });

  it('un admin suspendido no cuenta como admin activo', async () => {
    const t = await setup();
    await t.replace.execute(DEMO_USERS.auditor.id, { roleIds: [SYSTEM_ROLE_IDS.admin] }, admin);
    await t.handlers.handle(statusChanged(DEMO_USERS.auditor.id, 'SUSPENDED', 1));
    const otherAdmin: Actor = { id: DEMO_USERS.auditor.id, type: 'user' };
    expect(await errorCode(t.replace.execute(ADMIN_ID, { roleIds: [SYSTEM_ROLE_IDS.viewer] }, otherAdmin))).toBe('LAST_ADMIN');
  });
});

describe('consumidores de eventos', () => {
  it('account.registered agrega al directorio y asigna viewer una sola vez aunque el evento se re-entregue', async () => {
    const t = await setup();
    const event = registered(NEW_USER, '11111111-1111-4111-8111-111111111111');
    await t.handlers.handle(event);
    await t.handlers.handle(event);
    expect(await t.authz.execute(NEW_USER)).toMatchObject({ roles: ['viewer'] });
    expect(t.bus.types()).toEqual([EVENTS.ROLE_ASSIGNMENTS_CHANGED]);
    expect(t.bus.published[0].actor).toEqual({ id: null, type: 'system' });
  });

  it('un usuario que ya tiene roles (p. ej. el admin sembrado) no recibe viewer', async () => {
    const t = await setup();
    await t.handlers.handle(registered(ADMIN_ID));
    expect(await t.authz.execute(ADMIN_ID)).toMatchObject({ roles: ['admin'] });
    expect(t.bus.published).toHaveLength(0);
  });

  it('user.status_changed aplica solo versiones más nuevas; si el usuario aún no existe, falla para reintentar', async () => {
    const t = await setup();
    await t.handlers.handle(statusChanged(DEMO_USERS.viewer.id, 'SUSPENDED', 3));
    await t.handlers.handle(statusChanged(DEMO_USERS.viewer.id, 'ACTIVE', 2));
    expect((await t.directory.find(DEMO_USERS.viewer.id))?.status).toBe('SUSPENDED');
    await expect(t.handlers.handle(statusChanged(NEW_USER, 'SUSPENDED', 1))).rejects.toBeInstanceOf(UserNotYetKnownError);
    // El rollback deja el evento sin marcar: el reintento, ya con el usuario registrado, sí lo aplica.
    expect(t.store.state.processed.size).toBe(2);
  });

  it('usuario desconocido → autorización vacía (200, no 404)', async () => {
    const t = await setup();
    expect(await t.authz.execute(NEW_USER)).toEqual({ userId: NEW_USER, roles: [], permissions: [] });
  });
});
