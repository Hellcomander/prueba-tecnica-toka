import { Inject, Injectable } from '@nestjs/common';
import type { AuditCategory } from '@toka/contracts';
import { decodeCursor, encodeCursor } from './cursor';
import { InvalidQueryError } from './errors';
import { AUDIT_REPOSITORY, type AuditRepository } from './ports';
import { type AuditEntryView, toAuditView } from './record-audit-event.use-case';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const AUDIT_CATEGORIES = ['ACCESS', 'CHANGE', 'AI', 'OTHER'] as const satisfies readonly AuditCategory[];

export interface ListAuditInput {
  type?: string;
  category?: AuditCategory;
  actorId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  items: AuditEntryView[];
  /** `null` cuando no hay más páginas. */
  nextCursor: string | null;
}

/** Lado de lectura. Paginación por cursor (occurredAt, _id): estable aunque entren eventos nuevos. */
@Injectable()
export class ListAuditEventsQuery {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly entries: AuditRepository) {}

  async execute(input: ListAuditInput): Promise<AuditPage> {
    if (input.from && input.to && input.from > input.to) {
      throw new InvalidQueryError('INVALID_RANGE', '"from" no puede ser posterior a "to"');
    }
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const { cursor, limit: _limit, ...filter } = input;
    // Se pide una fila de más: si llega, hay página siguiente y no hace falta un count aparte.
    const rows = await this.entries.find({ ...filter, after: cursor ? decodeCursor(cursor) : undefined }, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toAuditView),
      nextCursor: rows.length > limit && last ? encodeCursor({ occurredAt: last.occurredAt, id: last.eventId }) : null,
    };
  }
}

export interface AuditStatsView {
  total: number;
  last24h: number;
  byCategory: Record<AuditCategory, number>;
  byType: Record<string, number>;
}

@Injectable()
export class GetAuditStatsQuery {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly entries: AuditRepository) {}

  async execute(now: Date = new Date()): Promise<AuditStatsView> {
    const snapshot = await this.entries.stats(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    // Todas las categorías siempre presentes (en 0) para que el dashboard no tenga que adivinar.
    const byCategory = Object.fromEntries(AUDIT_CATEGORIES.map((c) => [c, snapshot.byCategory[c] ?? 0])) as Record<AuditCategory, number>;
    return { total: snapshot.total, last24h: snapshot.last24h, byCategory, byType: snapshot.byType };
  }
}
