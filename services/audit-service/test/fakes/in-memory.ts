import type { AuditEntry, AuditFilter, AuditRepository, AuditStatsSnapshot } from '../../src/application/ports';

/**
 * Repositorio en memoria con el mismo contrato que el adaptador Mongoose: `_id = eventId`
 * (la re-entrega devuelve `false`), orden `occurredAt` desc + `eventId` desc y cursor estricto.
 * Sin update ni delete, igual que el puerto.
 */
export class InMemoryAuditRepository implements AuditRepository {
  readonly rows = new Map<string, AuditEntry>();

  async append(entry: AuditEntry): Promise<boolean> {
    if (this.rows.has(entry.eventId)) return false;
    this.rows.set(entry.eventId, structuredClone(entry));
    return true;
  }

  async find(filter: AuditFilter, limit: number): Promise<AuditEntry[]> {
    return [...this.rows.values()]
      .filter((e) => matches(e, filter))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0))
      .slice(0, limit)
      .map((e) => structuredClone(e));
  }

  async stats(since: Date): Promise<AuditStatsSnapshot> {
    const all = [...this.rows.values()];
    const count = (key: 'category' | 'type') =>
      all.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e[key]]: (acc[e[key]] ?? 0) + 1 }), {});
    return { total: all.length, last24h: all.filter((e) => e.occurredAt >= since).length, byCategory: count('category'), byType: count('type') };
  }
}

function matches(e: AuditEntry, f: AuditFilter): boolean {
  if (f.type && e.type !== f.type) return false;
  if (f.category && e.category !== f.category) return false;
  if (f.actorId && e.actor.id !== f.actorId) return false;
  if (f.from && e.occurredAt < f.from) return false;
  if (f.to && e.occurredAt > f.to) return false;
  if (f.after) {
    const t = e.occurredAt.getTime();
    const a = f.after.occurredAt.getTime();
    if (!(t < a || (t === a && e.eventId < f.after.id))) return false;
  }
  return true;
}
