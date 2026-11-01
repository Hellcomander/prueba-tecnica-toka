import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEMO_USERS, SCOPES, SYSTEM_ROLE_IDS } from '@toka/contracts';
import { AuthModule, CommonModule, configureApp, TestTokenFactory } from '@toka/nest-common';
import request from 'supertest';
import { CreateRoleUseCase } from '../src/application/commands/create-role.use-case';
import { DeleteRoleUseCase } from '../src/application/commands/delete-role.use-case';
import { ReplaceUserRolesUseCase } from '../src/application/commands/replace-user-roles.use-case';
import { SeedRolesUseCase } from '../src/application/commands/seed-roles.use-case';
import { UpdateRoleUseCase } from '../src/application/commands/update-role.use-case';
import { EVENT_BUS, PROCESSED_EVENTS, UNIT_OF_WORK } from '../src/application/ports';
import { GetAuthorizationQuery, GetRoleQuery, GetUserRolesQuery, ListPermissionsQuery, ListRolesQuery } from '../src/application/queries/role-queries';
import { ROLE_REPOSITORY, USER_ACCESS_REPOSITORY, USER_DIRECTORY_REPOSITORY } from '../src/domain/ports';
import { InternalAuthorizationsController, PermissionsController, RolesController, UserRolesController } from '../src/interface/http/role.controllers';
import { inMemoryContext } from './fakes/in-memory';

/**
 * Capa HTTP completa (controllers + DTOs + guards + filtro de errores) con los casos de uso
 * reales sobre repositorios en memoria. Los tokens son JWT RS256 reales.
 */
describe('role-service HTTP', () => {
  let app: INestApplication;
  let tokens: TestTokenFactory;
  const ctx = inMemoryContext();
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    tokens = await TestTokenFactory.create('http://auth.test');
    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({ service: 'role-service', level: 'silent' }),
        AuthModule.forRoot({ issuer: 'http://auth.test', keyResolver: tokens.keyResolver() }),
      ],
      controllers: [RolesController, PermissionsController, UserRolesController, InternalAuthorizationsController],
      providers: [
        { provide: ROLE_REPOSITORY, useValue: ctx.roles },
        { provide: USER_ACCESS_REPOSITORY, useValue: ctx.access },
        { provide: USER_DIRECTORY_REPOSITORY, useValue: ctx.directory },
        { provide: PROCESSED_EVENTS, useValue: ctx.processed },
        { provide: UNIT_OF_WORK, useValue: ctx.uow },
        { provide: EVENT_BUS, useValue: ctx.bus },
        CreateRoleUseCase,
        UpdateRoleUseCase,
        DeleteRoleUseCase,
        ReplaceUserRolesUseCase,
        SeedRolesUseCase,
        ListRolesQuery,
        GetRoleQuery,
        ListPermissionsQuery,
        GetUserRolesQuery,
        GetAuthorizationQuery,
      ],
    }).compile();
    await moduleRef.get(SeedRolesUseCase).execute({ demoUsers: true });
    app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
    await app.init();
    adminToken = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.admin.id, permissions: ['roles:read', 'roles:write', 'roles:assign'] })}`;
    viewerToken = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.viewer.id, roles: ['viewer'], permissions: ['roles:read'] })}`;
  });

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());

  it('GET /roles: 401 sin token, 200 con roles:read', async () => {
    expect((await http().get('/api/v1/roles')).status).toBe(401);
    const res = await http().get('/api/v1/roles').set('Authorization', viewerToken);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['admin', 'auditor', 'viewer']);
  });

  it('POST /roles: viewer → 403; admin → 201; DTO inválido → 400 con fieldErrors', async () => {
    const body = { name: 'Soporte', description: 'Mesa de ayuda', permissions: ['users:read'] };
    expect((await http().post('/api/v1/roles').set('Authorization', viewerToken).send(body)).status).toBe(403);

    const created = await http().post('/api/v1/roles').set('Authorization', adminToken).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'soporte', version: 1, isSystem: false });

    const invalid = await http().post('/api/v1/roles').set('Authorization', adminToken).send({ name: 'x', permissions: ['users:delete'], extra: 1 });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.fieldErrors).sort()).toEqual(['extra', 'name', 'permissions']);

    const duplicate = await http().post('/api/v1/roles').set('Authorization', adminToken).send(body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ROLE_NAME_TAKEN');
  });

  it('PATCH /roles/:id con versión vieja → 409 VERSION_CONFLICT; rol de sistema → 409', async () => {
    const created = await http().post('/api/v1/roles').set('Authorization', adminToken).send({ name: 'editable', permissions: ['users:read'] });
    const ok = await http().patch(`/api/v1/roles/${created.body.id}`).set('Authorization', adminToken).send({ version: 1, description: 'v2' });
    expect(ok.body.version).toBe(2);
    const stale = await http().patch(`/api/v1/roles/${created.body.id}`).set('Authorization', adminToken).send({ version: 1, description: 'v3' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const system = await http().patch(`/api/v1/roles/${SYSTEM_ROLE_IDS.viewer}`).set('Authorization', adminToken).send({ version: 1, description: 'x' });
    expect(system.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
  });

  it('GET /roles/:id con id no-UUID → 400; inexistente → 404; DELETE → 204', async () => {
    expect((await http().get('/api/v1/roles/abc').set('Authorization', viewerToken)).status).toBe(400);
    const missing = await http().get('/api/v1/roles/7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10').set('Authorization', viewerToken);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('ROLE_NOT_FOUND');
    const created = await http().post('/api/v1/roles').set('Authorization', adminToken).send({ name: 'temporal', permissions: ['users:read'] });
    expect((await http().get(`/api/v1/roles/${created.body.id}`).set('Authorization', viewerToken)).status).toBe(200);
    expect((await http().delete(`/api/v1/roles/${created.body.id}`).set('Authorization', adminToken)).status).toBe(204);
  });

  it('GET /permissions lista el catálogo', async () => {
    const res = await http().get('/api/v1/permissions').set('Authorization', viewerToken);
    expect(res.body).toContainEqual({ code: 'roles:assign', description: 'Asignar y quitar roles a usuarios' });
  });

  it('PUT /user-roles/:userId: asigna con roles:assign; protege al último admin y la auto-remoción', async () => {
    const assign = await http()
      .put(`/api/v1/user-roles/${DEMO_USERS.viewer.id}`)
      .set('Authorization', adminToken)
      .send({ roleIds: [SYSTEM_ROLE_IDS.auditor], assignmentsVersion: 1 });
    expect(assign.status).toBe(200);
    expect(assign.body).toMatchObject({ roles: [{ name: 'auditor' }], assignmentsVersion: 2 });
    expect((await http().get(`/api/v1/user-roles/${DEMO_USERS.viewer.id}`).set('Authorization', viewerToken)).body.assignmentsVersion).toBe(2);

    const self = await http().put(`/api/v1/user-roles/${DEMO_USERS.admin.id}`).set('Authorization', adminToken).send({ roleIds: [SYSTEM_ROLE_IDS.viewer] });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('SELF_ADMIN_REMOVAL');

    const otherAdmin = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.auditor.id, permissions: ['roles:assign'] })}`;
    const last = await http().put(`/api/v1/user-roles/${DEMO_USERS.admin.id}`).set('Authorization', otherAdmin).send({ roleIds: [SYSTEM_ROLE_IDS.viewer] });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_ADMIN');

    expect((await http().put(`/api/v1/user-roles/${DEMO_USERS.viewer.id}`).set('Authorization', viewerToken).send({ roleIds: [] })).status).toBe(403);
  });

  it('GET /internal/v1/authorizations: solo token de servicio con scope authz:read', async () => {
    const path = `/internal/v1/authorizations/${DEMO_USERS.admin.id}`;
    const service = `Bearer ${await tokens.serviceToken(SCOPES.AUTHZ_READ)}`;
    const ok = await http().get(path).set('Authorization', service);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ userId: DEMO_USERS.admin.id, roles: ['admin'] });
    expect(ok.body.permissions).toContain('roles:assign');
    expect((await http().get(path).set('Authorization', adminToken)).status).toBe(401);
    expect((await http().get(path).set('Authorization', `Bearer ${await tokens.serviceToken('otro:scope')}`)).status).toBe(403);
  });
});
