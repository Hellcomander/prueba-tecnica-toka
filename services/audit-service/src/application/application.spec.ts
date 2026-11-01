import { envelope } from '../../test/builders';
import { InMemoryAuditRepository } from '../../test/fakes/in-memory';
import { GetAuditStatsQuery, ListAuditEventsQuery, MAX_PAGE_SIZE } from './audit-queries';
import { decodeCursor, encodeCursor } from './cursor';
import { InvalidQueryError } from './errors';
import { RecordAuditEventUseCase } from './record-audit-event.use-case';

const setup = () => {
  const repo = new InMemoryAuditRepository();
  return { repo, record: new RecordAuditEventUseCase(repo), list: new ListAuditEventsQuery(repo), stats: new GetAuditStatsQuery(repo) };
};

describe('RecordAuditEventUseCase', () => {
  it('guarda el envelope completo con la categoría derivada del tipo', async () => {
    const { repo, record } = setup();
    const event = envelope({ type: 'role.created', data: { roleId: 'r' } });
    expect(await record.execute(event)).toBe(true);
    expect(repo.rows.get(event.eventId)).toMatchObject({
      eventId: event.eventId,
      type: 'role.created',
      category: 'CHANGE',
      version: 1,
      producer: 'auth-service',
      correlationId: 'corr-1',
      causationId: null,
      actor: { id: 'u-1', type: 'user' },
      subject: { type: 'user', id: 'u-1' },
      data: { roleId: 'r' },
    });
    expect(repo.rows.get(event.eventId)?.occurredAt).toEqual(new Date(event.occurredAt));
  });

  it('es idempotente: la re-entrega del mismo eventId se ignora y no duplica', async () => {
    const { repo, record } = setup();
    const event = envelope();
    expect(await record.execute(event)).toBe(true);
    expect(await record.execute(event)).toBe(false);
    expect(repo.rows.size).toBe(1);
  });

  it.each([
    ['auth.login_failed', 'ACCESS'],
    ['access.denied', 'ACCESS'],
    ['user.status_changed', 'CHANGE'],
    ['agent.query_completed', 'AI'],
    ['otro.evento_nuevo', 'OTHER'],
  ])('categoriza %s como %s (tipos nuevos incluidos)', async (type, category) => {
    const { repo, record } = setup();
    const event = envelope({ type });
    await record.execute(event);
    expect(repo.rows.get(event.eventId)?.category).toBe(category);
  });
});

describe('ListAuditEventsQuery', () => {
  const seed = async (n: number) => {
    const ctx = setup();
    for (let i = 0; i < n; i++) {
      // 3 eventos por milisegundo exacto: obliga al desempate por _id.
      await ctx.record.execute(envelope({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 3))).toISOString() }));
    }
    return ctx;
  };

  it('ordena por occurredAt descendente', async () => {
    const { list } = await seed(5);
    const { items } = await list.execute({});
    const times = items.map((i) => i.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('pagina por cursor sin repetir ni saltar filas, aun con empates de occurredAt', async () => {
    const { list } = await seed(10);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list.execute({ limit: 4, cursor });
      seen.push(...page.items.map((i) => i.eventId));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(10);
  });

  it('el cursor es estable cuando entran eventos nuevos entre páginas (un offset saltaría filas)', async () => {
    const { list, record } = await seed(6);
    const first = await list.execute({ limit: 3 });
    // llegan eventos más recientes mientras el cliente lee
    await record.execute(envelope({ at: '2030-01-01T00:00:00Z' }));
    await record.execute(envelope({ at: '2030-01-02T00:00:00Z' }));
    const second = await list.execute({ limit: 3, cursor: first.nextCursor! });
    const ids = [...first.items, ...second.items].map((i) => i.eventId);
    expect(new Set(ids).size).toBe(6);
    expect(second.nextCursor).toBeNull();
  });

  it('la última página no trae cursor', async () => {
    const { list } = await seed(3);
    expect((await list.execute({ limit: 3 })).nextCursor).toBeNull();
  });

  it('filtra por type, category, actorId y rango de fechas', async () => {
    const { list, record } = setup();
    await record.execute(envelope({ type: 'auth.login_failed', actorId: 'a', at: '2026-03-01T00:00:00Z' }));
    await record.execute(envelope({ type: 'role.created', actorId: 'b', at: '2026-03-10T00:00:00Z' }));
    await record.execute(envelope({ type: 'role.updated', actorId: 'b', at: '2026-03-20T00:00:00Z' }));
    expect((await list.execute({ type: 'role.created' })).items).toHaveLength(1);
    expect((await list.execute({ category: 'CHANGE' })).items).toHaveLength(2);
    expect((await list.execute({ actorId: 'a' })).items).toHaveLength(1);
    const range = await list.execute({ from: new Date('2026-03-05T00:00:00Z'), to: new Date('2026-03-15T00:00:00Z') });
    expect(range.items.map((i) => i.type)).toEqual(['role.created']);
  });

  it('acota el límite y rechaza rangos invertidos y cursores corruptos', async () => {
    const { list } = await seed(2);
    expect((await list.execute({ limit: 10_000 })).items).toHaveLength(2);
    expect(MAX_PAGE_SIZE).toBe(100);
    await expect(list.execute({ from: new Date('2026-02-01'), to: new Date('2026-01-01') })).rejects.toMatchObject({ code: 'INVALID_RANGE', kind: 'validation' });
    await expect(list.execute({ cursor: 'no-es-un-cursor' })).rejects.toBeInstanceOf(InvalidQueryError);
  });
});

describe('cursor', () => {
  it('ida y vuelta', () => {
    const position = { occurredAt: new Date('2026-05-05T10:00:00.123Z'), id: 'abc' };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it.each([
    ['JSON roto', Buffer.from('{').toString('base64url')],
    ['no es objeto', Buffer.from('null').toString('base64url')],
    ['faltan campos', Buffer.from('{"t":"2026-01-01T00:00:00Z"}').toString('base64url')],
    ['fecha inválida', Buffer.from('{"t":"hoy","id":"x"}').toString('base64url')],
  ])('rechaza %s', (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidQueryError);
  });
});

describe('GetAuditStatsQuery', () => {
  it('cuenta total, últimas 24 h, por categoría y por tipo (categorías vacías en 0)', async () => {
    const { stats, record } = setup();
    const now = new Date('2026-06-02T12:00:00Z');
    await record.execute(envelope({ type: 'auth.login_failed', at: '2026-06-02T08:00:00Z' }));
    await record.execute(envelope({ type: 'auth.login_failed', at: '2026-05-01T08:00:00Z' }));
    await record.execute(envelope({ type: 'role.created', at: '2026-06-02T09:00:00Z' }));
    expect(await stats.execute(now)).toEqual({
      total: 3,
      last24h: 2,
      byCategory: { ACCESS: 2, CHANGE: 1, AI: 0, OTHER: 0 },
      byType: { 'auth.login_failed': 2, 'role.created': 1 },
    });
  });

  it('colección vacía: todo en cero', async () => {
    const { stats } = setup();
    expect(await stats.execute()).toEqual({ total: 0, last24h: 0, byCategory: { ACCESS: 0, CHANGE: 0, AI: 0, OTHER: 0 }, byType: {} });
  });
});
