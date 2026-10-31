import 'reflect-metadata';
import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PROBLEM_CONTENT_TYPE, SCOPES } from '@toka/contracts';
import { IsInt, IsString, Length, Min } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';
import {
  type AccessDeniedEvent,
  AuthModule,
  type AuthenticatedUser,
  CommonModule,
  configureApp,
  CurrentPrincipal,
  CurrentUser,
  HealthModule,
  InternalRoute,
  Public,
  RequirePermissions,
  type ServicePrincipal,
  TestTokenFactory,
} from '../src';

class CreateItemDto {
  @IsString()
  @Length(1, 5)
  name!: string;

  @IsInt()
  @Min(1)
  qty!: number;
}

class ConflictError extends Error {
  readonly code = 'LAST_ADMIN';
  readonly kind = 'conflict';
}

@Controller()
class TestController {
  constructor(private readonly cls: ClsService) {}

  @Public()
  @Get('public')
  open() {
    return { ok: true, correlationId: this.cls.getId() };
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @RequirePermissions('users:write')
  @Get('admin-only')
  admin() {
    return { ok: true };
  }

  @RequirePermissions('users:read')
  @Post('items')
  create(@Body() dto: CreateItemDto) {
    return { created: dto, isDto: dto instanceof CreateItemDto };
  }

  @Public()
  @Get('domain-error')
  domainError() {
    throw new ConflictError('No se puede quitar el rol al último admin activo');
  }

  @Public()
  @Get('boom')
  boom() {
    throw new Error('detalle interno con password=123');
  }

  @InternalRoute(SCOPES.AUTHZ_READ)
  @Get('internal/v1/authorizations')
  internal(@CurrentPrincipal() principal: ServicePrincipal) {
    return principal;
  }
}

describe('nest-common integrado en una app Nest (e2e)', () => {
  let app: INestApplication;
  let tokens: TestTokenFactory;
  let dbUp = true;
  const denied: AccessDeniedEvent[] = [];

  beforeAll(async () => {
    tokens = await TestTokenFactory.create('http://auth.test');
    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({ service: 'test-svc', level: 'silent' }),
        AuthModule.forRoot({
          issuer: 'http://auth.test',
          keyResolver: tokens.keyResolver(),
          securityEvents: { useValue: { accessDenied: (e: AccessDeniedEvent) => void denied.push(e) } },
        }),
        HealthModule.forRoot({
          useFactory: () => [
            {
              name: 'postgres',
              check: async () => {
                if (!dbUp) throw new Error('down');
              },
            },
          ],
        }),
      ],
      controllers: [TestController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('rutas públicas responden sin token y propagan el correlation-id', async () => {
    const res = await http().get('/public').set('X-Correlation-Id', 'corr-12345678');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('corr-12345678');
    expect(res.body.correlationId).toBe('corr-12345678');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('un correlation-id inválido se reemplaza por uno generado', async () => {
    const res = await http().get('/public').set('X-Correlation-Id', 'mal!');
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('deny by default: sin token responde 401 problem+json con WWW-Authenticate', async () => {
    const res = await http().get('/me');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHORIZED', title: 'No autenticado', instance: '/me' });
    expect(res.body.correlationId).toBeDefined();
  });

  it('token válido → req.user; token expirado o basura → 401 invalid_token', async () => {
    const ok = await http().get('/me').set('Authorization', `Bearer ${await tokens.accessToken({ sub: 'u-1' })}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: 'u-1', tokenUse: 'access' });

    const expired = await http()
      .get('/me')
      .set('Authorization', `Bearer ${await tokens.accessToken({ expiresIn: Math.floor(Date.now() / 1000) - 120 })}`);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('TOKEN_EXPIRED');
    expect(expired.headers['www-authenticate']).toBe('Bearer error="invalid_token"');

    const garbage = await http().get('/me').set('Authorization', 'Bearer a.b.c');
    expect(garbage.body.code).toBe('INVALID_TOKEN');
  });

  it('sin el permiso requerido → 403 y se reporta la denegación (una vez por ventana)', async () => {
    const viewer = await tokens.accessToken({ sub: 'viewer-1', roles: ['viewer'], permissions: ['users:read'] });
    const res = await http().get('/admin-only').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.headers['www-authenticate']).toBe('Bearer error="insufficient_scope"');
    await http().get('/admin-only').set('Authorization', `Bearer ${viewer}`);
    await new Promise((r) => setImmediate(r));
    expect(denied).toEqual([{ userId: 'viewer-1', method: 'GET', route: '/admin-only', required: ['users:write'], reason: 'missing_permission' }]);

    const admin = await tokens.accessToken({ permissions: ['users:write'] });
    expect((await http().get('/admin-only').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
  });

  it('validación: campos inválidos o no declarados → 400 con fieldErrors; válido → DTO transformado', async () => {
    const token = `Bearer ${await tokens.accessToken({ permissions: ['users:read'] })}`;
    const bad = await http().post('/items').set('Authorization', token).send({ name: 'demasiado largo', qty: 0, isAdmin: true });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(bad.body.fieldErrors).sort()).toEqual(['isAdmin', 'name', 'qty']);

    const malformed = await http().post('/items').set('Authorization', token).set('Content-Type', 'application/json').send('{"name":');
    // Nest convierte el error del body-parser en BadRequestException.
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'Unexpected end of JSON input' });

    const good = await http().post('/items').set('Authorization', token).send({ name: 'ok', qty: 2 });
    expect(good.status).toBe(201);
    expect(good.body).toEqual({ created: { name: 'ok', qty: 2 }, isDto: true });
  });

  it('error de dominio → status por "kind" y code estable', async () => {
    const res = await http().get('/domain-error');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'LAST_ADMIN', detail: 'No se puede quitar el rol al último admin activo', type: 'urn:toka:problem:last_admin' });
  });

  it('error inesperado → 500 genérico, sin filtrar el mensaje interno', async () => {
    const res = await http().get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('ruta interna: exige token de servicio con scope; rechaza tokens de usuario', async () => {
    const service = await tokens.serviceToken(SCOPES.AUTHZ_READ);
    const ok = await http().get('/internal/v1/authorizations').set('Authorization', `Bearer ${service}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: 'service:auth-service', tokenUse: 'service' });

    const user = await http().get('/internal/v1/authorizations').set('Authorization', `Bearer ${await tokens.accessToken()}`);
    expect(user.status).toBe(401);

    const wrongScope = await http().get('/internal/v1/authorizations').set('Authorization', `Bearer ${await tokens.serviceToken('otro:scope')}`);
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body.code).toBe('INSUFFICIENT_SCOPE');

    const serviceOnUserRoute = await http().get('/me').set('Authorization', `Bearer ${service}`);
    expect(serviceOnUserRoute.status).toBe(401);
  });

  it('health: live siempre; ready refleja el store propio', async () => {
    expect((await http().get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await http().get('/health/ready')).body).toEqual({ status: 'ok', checks: { postgres: 'up' } });
    dbUp = false;
    const down = await http().get('/health/ready');
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: 'down', checks: { postgres: 'down' } });
    dbUp = true;
  });

  it('404 de ruta inexistente también sale como problem+json', async () => {
    const res = await http().get('/no-existe').set('Authorization', `Bearer ${await tokens.accessToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
