import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEMO_USERS, SYSTEM_ROLE_IDS, createEnvelope, EVENTS } from '@toka/contracts';
import { AuthModule, CommonModule, configureApp, TestTokenFactory } from '@toka/nest-common';
import request from 'supertest';
import { ReactivateUserUseCase, SuspendUserUseCase } from '../src/application/commands/change-status.use-case';
import { UpdateProfileUseCase } from '../src/application/commands/update-profile.use-case';
import { UserEventHandlers } from '../src/application/events/user-event-handlers';
import { EVENT_BUS, PROCESSED_EVENTS, STATS_CACHE, UNIT_OF_WORK } from '../src/application/ports';
import { USER_READ_MODEL } from '../src/application/queries/read-model';
import { GetUserQuery, GetUserStatsQuery, ListUsersQuery } from '../src/application/queries/user-queries';
import { USER_PROFILE_REPOSITORY, USER_ROLES_PROJECTION_REPOSITORY } from '../src/domain/ports';
import { UsersController } from '../src/interface/http/user.controllers';
import { inMemoryContext } from './fakes/in-memory';

/**
 * Capa HTTP completa (controllers + DTOs + guards + filtro de errores) con los casos de uso
 * reales sobre repositorios en memoria. Los tokens son JWT RS256 reales.
 */
describe('user-service HTTP', () => {
  let app: INestApplication;
  let tokens: TestTokenFactory;
  const ctx = inMemoryContext();
  let adminToken: string;
  let viewerToken: string;
  let auditorToken: string;
  const MISSING = '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10';
  const admin = { id: DEMO_USERS.admin.id, name: 'admin' };
  const roleOf = (name: string) => ({ id: name === 'admin' ? SYSTEM_ROLE_IDS.admin : SYSTEM_ROLE_IDS.viewer, name });

  beforeAll(async () => {
    tokens = await TestTokenFactory.create('http://auth.test');
    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({ service: 'user-service', level: 'silent' }),
        AuthModule.forRoot({ issuer: 'http://auth.test', keyResolver: tokens.keyResolver() }),
      ],
      controllers: [UsersController],
      providers: [
        { provide: USER_PROFILE_REPOSITORY, useValue: ctx.profiles },
        { provide: USER_ROLES_PROJECTION_REPOSITORY, useValue: ctx.projections },
        { provide: USER_READ_MODEL, useValue: ctx.readModel },
        { provide: PROCESSED_EVENTS, useValue: ctx.processed },
        { provide: UNIT_OF_WORK, useValue: ctx.uow },
        { provide: EVENT_BUS, useValue: ctx.bus },
        { provide: STATS_CACHE, useValue: ctx.cache },
        UpdateProfileUseCase,
        SuspendUserUseCase,
        ReactivateUserUseCase,
        UserEventHandlers,
        ListUsersQuery,
        GetUserQuery,
        GetUserStatsQuery,
      ],
    }).compile();

    // Datos de partida por el mismo camino que en producción: los eventos.
    const handlers = moduleRef.get(UserEventHandlers);
    for (const u of Object.values(DEMO_USERS)) {
      await handlers.handle(
        createEnvelope({
          type: EVENTS.ACCOUNT_REGISTERED,
          producer: 'auth-service',
          correlationId: 'corr-12345678',
          subject: { type: 'user', id: u.id },
          data: { userId: u.id, email: u.email, fullName: u.fullName, source: 'seed' as const },
        }),
      );
      await handlers.handle(
        createEnvelope({
          type: EVENTS.ROLE_ASSIGNMENTS_CHANGED,
          producer: 'role-service',
          correlationId: 'corr-12345678',
          subject: { type: 'user', id: u.id },
          data: { userId: u.id, roles: [roleOf(u.role)], assignmentsVersion: 1 },
        }),
      );
    }

    app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
    await app.init();
    adminToken = `Bearer ${await tokens.accessToken({ sub: admin.id, permissions: ['users:read', 'users:write'] })}`;
    auditorToken = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.auditor.id, roles: ['auditor'], permissions: ['users:read'] })}`;
    viewerToken = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.viewer.id, email: DEMO_USERS.viewer.email, roles: ['viewer'], permissions: [] })}`;
  });

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());

  it('GET /users: 401 sin token, 403 sin users:read, 200 con lista paginada', async () => {
    expect((await http().get('/api/v1/users')).status).toBe(401);
    expect((await http().get('/api/v1/users').set('Authorization', viewerToken)).status).toBe(403);
    const res = await http().get('/api/v1/users').set('Authorization', auditorToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(res.body.items.map((u: { fullName: string }) => u.fullName)).toEqual(['Aldo Auditor', 'Ana Admin', 'Vera Viewer']);
    expect(res.body.items[1].roles).toEqual(['admin']);
  });

  it('GET /users: search, status (sin importar mayúsculas), page y pageSize; parámetros inválidos → 400', async () => {
    const search = await http().get('/api/v1/users?search=vera').set('Authorization', auditorToken);
    expect(search.body.items.map((u: { id: string }) => u.id)).toEqual([DEMO_USERS.viewer.id]);
    const paged = await http().get('/api/v1/users?page=2&pageSize=2').set('Authorization', auditorToken);
    expect(paged.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(paged.body.items).toHaveLength(1);
    expect((await http().get('/api/v1/users?status=suspended').set('Authorization', auditorToken)).body.total).toBe(0);
    const invalid = await http().get('/api/v1/users?status=raro&page=0&pageSize=1000&x=1').set('Authorization', auditorToken);
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.fieldErrors).sort()).toEqual(['page', 'pageSize', 'status', 'x']);
  });

  it('las rutas fijas /me y /stats NO chocan con /:id (Express 5)', async () => {
    const me = await http().get('/api/v1/users/me').set('Authorization', viewerToken);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: DEMO_USERS.viewer.id, email: DEMO_USERS.viewer.email, roles: ['viewer'] });

    const stats = await http().get('/api/v1/users/stats').set('Authorization', auditorToken);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ total: 3, active: 3, activeAdmins: 1 });

    // /stats exige users:read; /me no exige permiso extra. Y un id que no es UUID sigue siendo 400.
    expect((await http().get('/api/v1/users/stats').set('Authorization', viewerToken)).status).toBe(403);
    expect((await http().get('/api/v1/users/abc').set('Authorization', auditorToken)).status).toBe(400);
    expect((await http().get('/api/v1/users/me')).status).toBe(401);
  });

  it('GET /users/:id: 200 con users:read, 404 inexistente', async () => {
    expect((await http().get(`/api/v1/users/${DEMO_USERS.admin.id}`).set('Authorization', auditorToken)).body).toMatchObject({ fullName: 'Ana Admin', status: 'ACTIVE' });
    const missing = await http().get(`/api/v1/users/${MISSING}`).set('Authorization', auditorToken);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('USER_NOT_FOUND');
    expect((await http().get(`/api/v1/users/${DEMO_USERS.admin.id}`).set('Authorization', viewerToken)).status).toBe(403);
  });

  it('PATCH /users/me: cualquier usuario edita su perfil; DTO inválido → 400; campos ajenos se rechazan', async () => {
    const ok = await http().patch('/api/v1/users/me').set('Authorization', viewerToken).send({ jobTitle: ' Analista ', department: 'Operaciones' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ jobTitle: 'Analista', department: 'Operaciones', version: 2 });
    const cleared = await http().patch('/api/v1/users/me').set('Authorization', viewerToken).send({ department: null });
    expect(cleared.body.department).toBeNull();
    const invalid = await http().patch('/api/v1/users/me').set('Authorization', viewerToken).send({ fullName: '', status: 'SUSPENDED', email: 'x@y.z' });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.fieldErrors).sort()).toEqual(['email', 'fullName', 'status']);
    const stale = await http().patch('/api/v1/users/me').set('Authorization', viewerToken).send({ version: 1, jobTitle: 'Otro' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('PATCH /users/:id: exige users:write y versión; versión vieja → 409 VERSION_CONFLICT', async () => {
    const path = `/api/v1/users/${DEMO_USERS.auditor.id}`;
    expect((await http().patch(path).set('Authorization', auditorToken).send({ version: 1, jobTitle: 'X' })).status).toBe(403);
    expect((await http().patch(path).set('Authorization', adminToken).send({ jobTitle: 'X' })).status).toBe(400);
    const ok = await http().patch(path).set('Authorization', adminToken).send({ version: 1, jobTitle: 'Auditor sr.' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await http().patch(path).set('Authorization', adminToken).send({ version: 1, jobTitle: 'Otro' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect((await http().patch(`/api/v1/users/${MISSING}`).set('Authorization', adminToken).send({ version: 1, jobTitle: 'X' })).body.code).toBe('USER_NOT_FOUND');
  });

  it('suspend/reactivate: exigen users:write; protegen auto-suspensión y al último admin; publican eventos', async () => {
    const viewerPath = `/api/v1/users/${DEMO_USERS.viewer.id}`;
    expect((await http().post(`${viewerPath}/suspend`).set('Authorization', auditorToken)).status).toBe(403);

    const self = await http().post(`/api/v1/users/${DEMO_USERS.admin.id}/suspend`).set('Authorization', adminToken);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('SELF_SUSPENSION');

    // Otro usuario con users:write intenta suspender al único admin activo.
    const writer = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.auditor.id, permissions: ['users:write'] })}`;
    const last = await http().post(`/api/v1/users/${DEMO_USERS.admin.id}/suspend`).set('Authorization', writer);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_ADMIN');

    ctx.bus.published = [];
    const suspended = await http().post(`${viewerPath}/suspend`).set('Authorization', adminToken).send({ reason: 'baja temporal' });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ status: 'SUSPENDED', statusReason: 'baja temporal' });
    expect(ctx.bus.published[0]).toMatchObject({ type: 'user.status_changed', data: { userId: DEMO_USERS.viewer.id, status: 'SUSPENDED', version: suspended.body.version } });
    expect((await http().post(`${viewerPath}/suspend`).set('Authorization', adminToken)).body.code).toBe('ALREADY_SUSPENDED');

    const reactivated = await http().post(`${viewerPath}/reactivate`).set('Authorization', adminToken).send({});
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ status: 'ACTIVE', statusReason: null });
    expect((await http().post(`${viewerPath}/reactivate`).set('Authorization', adminToken)).body.code).toBe('ALREADY_ACTIVE');
    expect((await http().post(`${viewerPath}/suspend`).set('Authorization', adminToken).send({ reason: 'x'.repeat(201) })).status).toBe(400);
  });
});
