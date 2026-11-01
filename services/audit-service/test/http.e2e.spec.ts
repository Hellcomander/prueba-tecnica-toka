import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule, CommonModule, configureApp, TestTokenFactory } from '@toka/nest-common';
import request from 'supertest';
import { GetAuditStatsQuery, ListAuditEventsQuery } from '../src/application/audit-queries';
import { AUDIT_REPOSITORY } from '../src/application/ports';
import { RecordAuditEventUseCase } from '../src/application/record-audit-event.use-case';
import { AuditController } from '../src/interface/http/audit.controller';
import { envelope } from './builders';
import { InMemoryAuditRepository } from './fakes/in-memory';

/**
 * Capa HTTP completa (controller + DTO + guards + filtro de errores) con los casos de uso reales
 * sobre un repositorio en memoria. Los tokens son JWT RS256 reales.
 */
describe('audit-service HTTP', () => {
  let app: INestApplication;
  let tokens: TestTokenFactory;
  let record: RecordAuditEventUseCase;
  let auditor: string;
  let viewer: string;

  beforeAll(async () => {
    tokens = await TestTokenFactory.create('http://auth.test');
    const repo = new InMemoryAuditRepository();
    const moduleRef = await Test.createTestingModule({
      imports: [
        CommonModule.forRoot({ service: 'audit-service', level: 'silent' }),
        AuthModule.forRoot({ issuer: 'http://auth.test', keyResolver: tokens.keyResolver() }),
      ],
      controllers: [AuditController],
      providers: [{ provide: AUDIT_REPOSITORY, useValue: repo }, RecordAuditEventUseCase, ListAuditEventsQuery, GetAuditStatsQuery],
    }).compile();
    record = moduleRef.get(RecordAuditEventUseCase);
    app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
    await app.init();
    auditor = `Bearer ${await tokens.accessToken({ roles: ['auditor'], permissions: ['audit:read'] })}`;
    viewer = `Bearer ${await tokens.accessToken({ roles: ['viewer'], permissions: ['users:read'] })}`;

    for (let i = 0; i < 7; i++) {
      await record.execute(envelope({ type: i % 2 ? 'role.created' : 'auth.login_failed', actorId: i < 3 ? 'actor-a' : 'actor-b', at: `2026-04-0${1 + Math.floor(i / 2)}T00:00:00Z` }));
    }
  });

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());

  it('401 sin token y 403 sin audit:read (en ambas rutas)', async () => {
    expect((await http().get('/api/v1/audit/events')).status).toBe(401);
    for (const path of ['/api/v1/audit/events', '/api/v1/audit/stats']) {
      const res = await http().get(path).set('Authorization', viewer);
      expect(res.status).toBe(403);
    }
  });

  it('GET /events: 200 con audit:read, forma de la entrada y orden descendente', async () => {
    const res = await http().get('/api/v1/audit/events').set('Authorization', auditor);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(7);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items[0]).toEqual(
      expect.objectContaining({ eventId: expect.any(String), type: expect.any(String), category: expect.stringMatching(/ACCESS|CHANGE/), occurredAt: expect.any(String), correlationId: 'corr-1', actor: expect.any(Object), subject: expect.any(Object) }),
    );
    const times = res.body.items.map((i: { occurredAt: string }) => i.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('paginación por cursor: recorre todo sin repetir, y es estable si entran eventos nuevos', async () => {
    const first = await http().get('/api/v1/audit/events?limit=3').set('Authorization', auditor);
    expect(first.body.items).toHaveLength(3);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    // Llega un evento nuevo mientras el cliente pagina: no debe desplazar las páginas restantes.
    await record.execute(envelope({ at: '2030-01-01T00:00:00Z' }));

    const seen = first.body.items.map((i: { eventId: string }) => i.eventId);
    let cursor: string | null = first.body.nextCursor;
    while (cursor) {
      const page = await http().get(`/api/v1/audit/events?limit=3&cursor=${encodeURIComponent(cursor)}`).set('Authorization', auditor);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i: { eventId: string }) => i.eventId));
      cursor = page.body.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('filtra por category, type, actorId y rango', async () => {
    const get = (qs: string) => http().get(`/api/v1/audit/events?${qs}`).set('Authorization', auditor);
    expect((await get('category=CHANGE')).body.items.every((i: { category: string }) => i.category === 'CHANGE')).toBe(true);
    expect((await get('type=role.created')).body.items.every((i: { type: string }) => i.type === 'role.created')).toBe(true);
    expect((await get('actorId=actor-a')).body.items).toHaveLength(3);
    expect((await get('from=2026-04-02T00:00:00Z&to=2026-04-02T23:59:59Z')).body.items).toHaveLength(2);
  });

  it('400 con entrada inválida: cursor corrupto, fecha, categoría, límite, rango invertido y campos desconocidos', async () => {
    const get = (qs: string) => http().get(`/api/v1/audit/events?${qs}`).set('Authorization', auditor);
    expect((await get('cursor=basura')).body.code).toBe('INVALID_CURSOR');
    expect((await get('cursor=basura')).status).toBe(400);
    expect((await get('from=ayer')).status).toBe(400);
    expect((await get('category=NOPE')).status).toBe(400);
    expect((await get('limit=0')).status).toBe(400);
    expect((await get('limit=101')).status).toBe(400);
    expect((await get('foo=bar')).status).toBe(400);
    const range = await get('from=2026-05-01T00:00:00Z&to=2026-04-01T00:00:00Z');
    expect(range.status).toBe(400);
    expect(range.body.code).toBe('INVALID_RANGE');
  });

  it('GET /stats: conteos agregados con todas las categorías', async () => {
    const res = await http().get('/api/v1/audit/stats').set('Authorization', auditor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 8, byCategory: expect.objectContaining({ ACCESS: expect.any(Number), CHANGE: expect.any(Number), AI: 0, OTHER: 0 }) });
    expect(res.body.byType['role.created']).toBe(3);
  });

  it('no existen rutas de escritura: POST/PUT/PATCH/DELETE → 404', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await http()[method]('/api/v1/audit/events').set('Authorization', auditor)).status).toBe(404);
    }
  });
});
