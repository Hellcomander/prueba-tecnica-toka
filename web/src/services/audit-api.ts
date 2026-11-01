import { api } from '@/lib/api';

export const AUDIT_CATEGORIES = ['ACCESS', 'CHANGE', 'AI', 'OTHER'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** Espejo de AuditEntryView: el envelope completo del evento, tal como se guardó. */
export interface AuditEntryView {
  eventId: string;
  type: string;
  category: AuditCategory;
  version: number;
  occurredAt: string;
  producer: string;
  correlationId: string;
  causationId: string | null;
  actor: { id: string | null; type: 'user' | 'service' | 'system' };
  subject: { type: string; id: string };
  data: unknown;
}

/**
 * Paginación por cursor, no por página: la bitácora solo crece, y un offset se saltaría o
 * repetiría registros cuando entran eventos nuevos entre una página y la siguiente.
 */
export interface AuditPage {
  items: AuditEntryView[];
  nextCursor: string | null;
}

export interface AuditStats {
  total: number;
  last24h: number;
  byCategory: Record<AuditCategory, number>;
  byType: Record<string, number>;
}

export interface ListAuditParams {
  type?: string;
  category?: AuditCategory;
  actorId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export const auditApi = {
  list: async (params: ListAuditParams): Promise<AuditPage> => {
    const { data } = await api.get<AuditPage>('/audit/events', { params });
    return data;
  },
  stats: async (): Promise<AuditStats> => {
    const { data } = await api.get<AuditStats>('/audit/stats');
    return data;
  },
};
