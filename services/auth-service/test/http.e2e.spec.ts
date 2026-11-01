import 'reflect-metadata';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DEMO_USERS, SYSTEM_ROLES } from '@toka/contracts';
import { AuthModule, CommonModule, configureApp, TestTokenFactory } from '@toka/nest-common';
import cookieParser from 'cookie-parser';
import { createLocalJWKSet, decodeJwt, type JWK } from 'jose';
import request from 'supertest';
import { CreateAccountUseCase } from '../src/application/commands/create-account.use-case';
import { LoginUseCase } from '../src/application/commands/login.use-case';
import { LogoutUseCase } from '../src/application/commands/logout.use-case';
import { RefreshUseCase } from '../src/application/commands/refresh.use-case';
import { SeedAccountsUseCase } from '../src/application/commands/seed-accounts.use-case';
import {
  ATTEMPT_LIMITER,
  AUTH_SETTINGS,
  AUTHORIZATION_CACHE,
  AUTHORIZATION_PROVIDER,
  EVENT_BUS,
  KEY_SET_PROVIDER,
  PROCESSED_EVENTS,
  TOKEN_SIGNER,
  UNIT_OF_WORK,
} from '../src/application/ports';
import { DiscoveryQuery, JwksQuery, UserInfoQuery } from '../src/application/queries/auth-queries';
import { AuthorizationResolver } from '../src/application/services/authorization-resolver';
import { ACCOUNT_REPOSITORY, PASSWORD_HASHER, SESSION_REPOSITORY } from '../src/domain/ports';
import { JoseTokenSigner } from '../src/infrastructure/keys/jose-token-signer';
import { FileKeyStore } from '../src/infrastructure/keys/key-store';
import { AccountsController, AuthController, DiscoveryController } from '../src/interface/http/auth.controllers';
import { COOKIE_SECURE } from '../src/interface/http/cookies';
import { inMemoryContext, testSettings } from './fakes/in-memory';

const ISSUER = 'http://auth.test';
const ADMIN_PASSWORD = 'Admin123!demo';
const cookieOf = (res: request.Response): string => (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('toka_refresh='))!;
const valueOf = (cookie: string) => cookie.split(';')[0];

/**
 * Capa HTTP completa (controllers + DTOs + guards + cookies + filtro de errores) con los casos de
 * uso reales sobre repositorios en memoria. Los JWT son RS256 de verdad: auth firma con su propio
 * key store y el guard de nest-common valida contra ese mismo JWKS, que es exactamente lo que
 * harán los otros tres servicios en producción.
 */
describe('auth-service HTTP', () => {
  let app: INestApplication;
  const ctx = inMemoryContext();
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    const keys = new FileKeyStore(await mkdtemp(join(tmpdir(), 'toka-auth-keys-')));
    const ownJwks = await keys.jwks();
    const tokens = await TestTokenFactory.create(ISSUER);
    const settings = testSettings({ issuer: ISSUER });

    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({ service: 'auth-service', level: 'silent' }),
        AuthModule.forRoot({
          issuer: ISSUER,
          // Las dos llaves públicas: la que emite auth en este test y la del TestTokenFactory
          // (el token de admin con el que se llama a /api/v1/accounts). jose elige por kid.
          keyResolver: createLocalJWKSet({ keys: [...(ownJwks.keys as unknown as JWK[]), tokens.publicJwk] }),
        }),
      ],
      controllers: [AuthController, AccountsController, DiscoveryController],
      providers: [
        { provide: ACCOUNT_REPOSITORY, useValue: ctx.accounts },
        { provide: SESSION_REPOSITORY, useValue: ctx.sessions },
        { provide: PASSWORD_HASHER, useValue: ctx.hasher },
        { provide: PROCESSED_EVENTS, useValue: ctx.processed },
        { provide: UNIT_OF_WORK, useValue: ctx.uow },
        { provide: EVENT_BUS, useValue: ctx.bus },
        { provide: ATTEMPT_LIMITER, useValue: ctx.limiter },
        { provide: AUTHORIZATION_PROVIDER, useValue: ctx.provider },
        { provide: AUTHORIZATION_CACHE, useValue: ctx.cache },
        { provide: AUTH_SETTINGS, useValue: settings },
        { provide: COOKIE_SECURE, useValue: false },
        { provide: KEY_SET_PROVIDER, useValue: keys },
        { provide: TOKEN_SIGNER, useValue: new JoseTokenSigner(keys, settings) },
        AuthorizationResolver,
        LoginUseCase,
        RefreshUseCase,
        LogoutUseCase,
        CreateAccountUseCase,
        SeedAccountsUseCase,
        UserInfoQuery,
        DiscoveryQuery,
        JwksQuery,
      ],
    }).compile();

    await moduleRef.get(SeedAccountsUseCase).execute({ demoUsers: true });
    ctx.provider.authorizations.set(DEMO_USERS.admin.id, { userId: DEMO_USERS.admin.id, roles: ['admin'], permissions: [...SYSTEM_ROLES.admin] });
    ctx.provider.authorizations.set(DEMO_USERS.viewer.id, { userId: DEMO_USERS.viewer.id, roles: ['viewer'], permissions: [...SYSTEM_ROLES.viewer] });

    app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
    app.use(cookieParser());
    await app.init();
    adminToken = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.admin.id, permissions: ['users:read', 'users:write'] })}`;
    viewerToken = `Bearer ${await tokens.accessToken({ sub: DEMO_USERS.viewer.id, roles: ['viewer'], permissions: ['users:read'] })}`;
  });

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());
  const login = (email: string, password: string) => http().post('/api/v1/auth/login').send({ email, password });

  it('el discovery y el JWKS son públicos y no filtran material privado', async () => {
    const discovery = await http().get('/.well-known/openid-configuration');
    expect(discovery.status).toBe(200);
    expect(discovery.body).toMatchObject({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
    expect(discovery.body.token_endpoint).toBeUndefined();

    const jwks = await http().get('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys).toHaveLength(1);
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(jwks.body.keys[0].kid).toEqual(expect.any(String));
    expect(jwks.body.keys[0].d).toBeUndefined();
  });

  it('POST /auth/login: 400 con DTO inválido, 401 con credenciales malas, 200 con cookie HttpOnly', async () => {
    const invalid = await login('no-es-un-email', '1');
    expect(invalid.status).toBe(400);
    expect(invalid.headers['content-type']).toContain('application/problem+json');
    expect(Object.keys(invalid.body.fieldErrors)).toContain('email');

    const wrong = await login(DEMO_USERS.admin.email, 'Equivocada1234');
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

    const ok = await login(DEMO_USERS.admin.email, ADMIN_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });
    expect(ok.body.user).toMatchObject({ id: DEMO_USERS.admin.id, email: DEMO_USERS.admin.email, roles: ['admin'] });

    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/i);
    expect(cookie).not.toMatch(/Secure/i); // COOKIE_SECURE=false en local (http)
    // El refresh viaja solo por cookie: no se filtra en el cuerpo de la respuesta.
    expect(ok.text).not.toContain(valueOf(cookie).split('=')[1]);
  });

  it('el access token que emite auth es un RS256 válido para sus propios guards (JWKS)', async () => {
    const ok = await login(DEMO_USERS.admin.email, ADMIN_PASSWORD);
    const claims = decodeJwt(ok.body.accessToken);
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: 'toka-api',
      sub: DEMO_USERS.admin.id,
      token_use: 'access',
      email: DEMO_USERS.admin.email,
      roles: ['admin'],
    });
    expect(claims.sid).toBe(ok.body.user.sessionId);
    expect(claims.jti).toEqual(expect.any(String));
    expect(claims.permissions).toContain('users:write');
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600);

    const me = await http().get('/api/v1/auth/userinfo').set('Authorization', `Bearer ${ok.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: DEMO_USERS.admin.id, email: DEMO_USERS.admin.email });
    expect((await http().get('/api/v1/auth/userinfo')).status).toBe(401);
  });

  it('POST /accounts: 403 sin users:write, 201 para un admin, 400 con payload inválido', async () => {
    const body = { email: 'nueva@toka.local', password: 'Nueva123!demo', fullName: 'Nora Nueva' };
    expect((await http().post('/api/v1/accounts').set('Authorization', viewerToken).send(body)).status).toBe(403);
    expect((await http().post('/api/v1/accounts').send(body)).status).toBe(401);

    const created = await http().post('/api/v1/accounts').set('Authorization', adminToken).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: 'nueva@toka.local', status: 'ACTIVE' });

    const duplicated = await http().post('/api/v1/accounts').set('Authorization', adminToken).send(body);
    expect(duplicated.status).toBe(409);
    expect(duplicated.body.code).toBe('EMAIL_TAKEN');

    const invalid = await http()
      .post('/api/v1/accounts')
      .set('Authorization', adminToken)
      .send({ email: 'no-es-un-email', password: '123', fullName: '', extra: 1 });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.fieldErrors).sort()).toEqual(['email', 'extra', 'fullName', 'password']);
  });

  it('refresh rota la cookie, el token viejo da 401 y el logout cierra la sesión', async () => {
    const first = valueOf(cookieOf(await login(DEMO_USERS.viewer.email, 'Viewer123!demo')));

    const rotated = await http().post('/api/v1/auth/refresh').set('Cookie', first);
    expect(rotated.status).toBe(200);
    const second = valueOf(cookieOf(rotated));
    expect(second).not.toBe(first);

    const reused = await http().post('/api/v1/auth/refresh').set('Cookie', first);
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('INVALID_REFRESH_TOKEN');
    // Reusar el viejo mata la familia: el token "bueno" tampoco sirve ya.
    expect((await http().post('/api/v1/auth/refresh').set('Cookie', second)).status).toBe(401);

    const third = valueOf(cookieOf(await login(DEMO_USERS.viewer.email, 'Viewer123!demo')));
    const out = await http().post('/api/v1/auth/logout').set('Cookie', third);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/toka_refresh=;/);
    expect((await http().post('/api/v1/auth/refresh').set('Cookie', third)).status).toBe(401);
    // Sin cookie no hay sesión que cerrar, pero tampoco error: el logout es idempotente.
    expect((await http().post('/api/v1/auth/logout')).status).toBe(204);
    expect((await http().post('/api/v1/auth/refresh')).status).toBe(401);
  });

  it('tras varios intentos fallidos el lockout responde 429 con Retry-After', async () => {
    const victima = 'lockout@toka.local';
    for (let i = 0; i < 5; i += 1) expect((await login(victima, 'Equivocada1234')).status).toBe(401);

    const locked = await login(victima, 'Equivocada1234');
    expect(locked.status).toBe(429);
    expect(locked.headers['content-type']).toContain('application/problem+json');
    expect(locked.headers['retry-after']).toBe('60');
    expect(locked.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS', status: 429 });
  });
});
