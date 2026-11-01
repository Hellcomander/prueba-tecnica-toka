import { create } from 'zustand';
import { auditApi, type AuditEntryView, type AuditStats, type ListAuditParams } from '@/services/audit-api';
import { describeProblem } from '@/lib/problem';

type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

export const AUDIT_PAGE_SIZE = 20;

export interface AuditFilters {
  type: string;
  category: string;
  actorId: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditFilters = { type: '', category: '', actorId: '', from: '', to: '' };

interface AuditState {
  status: RequestStatus;
  error: string | null;
  items: AuditEntryView[];
  nextCursor: string | null;
  loadingMore: boolean;
  filters: AuditFilters;
  stats: AuditStats | null;
  setFilters: (filters: AuditFilters) => void;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  loadStats: () => Promise<void>;
  reset: () => void;
}

const initialState = {
  status: 'idle' as RequestStatus,
  error: null,
  items: [] as AuditEntryView[],
  nextCursor: null,
  loadingMore: false,
  filters: EMPTY_FILTERS,
  stats: null,
};

/**
 * Traduce los filtros de la interfaz a parámetros del servicio. Las fechas se capturan como día
 * (`<input type="date">`) y se envían como instantes: el día "desde" empieza a las 00:00 y el
 * día "hasta" se incluye completo hasta el último milisegundo, que es lo que espera quien
 * filtra "del 1 al 3" y quiere ver lo que pasó el día 3.
 *
 * El día se interpreta en la zona horaria de quien mira, no en UTC. Sin el ajuste, alguien en
 * Ciudad de México (UTC-6) que filtra "1 de noviembre" recibía del 31 de octubre a las 18:00
 * al 1 de noviembre a las 17:59: seis horas corridas en ambos extremos. Omitir la `Z` hace que
 * Date interprete la fecha como local, y `toISOString()` la convierte al instante correcto.
 */
const startOfLocalDay = (day: string): string => new Date(`${day}T00:00:00.000`).toISOString();
const endOfLocalDay = (day: string): string => new Date(`${day}T23:59:59.999`).toISOString();

function toParams(filters: AuditFilters): ListAuditParams {
  return {
    type: filters.type || undefined,
    category: (filters.category || undefined) as ListAuditParams['category'],
    actorId: filters.actorId.trim() || undefined,
    from: filters.from ? startOfLocalDay(filters.from) : undefined,
    to: filters.to ? endOfLocalDay(filters.to) : undefined,
    limit: AUDIT_PAGE_SIZE,
  };
}

export const useAuditStore = create<AuditState>((set, get) => ({
  ...initialState,

  // Cambiar un filtro invalida el cursor: apunta a una posición del listado anterior.
  setFilters: (filters) => set({ filters, items: [], nextCursor: null }),

  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const page = await auditApi.list(toParams(get().filters));
      set({ status: 'success', items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      set({ status: 'error', error: describeProblem(error) });
    }
  },

  /**
   * Paginación por cursor: se acumula sobre lo ya cargado en vez de reemplazarlo. La bitácora
   * solo crece y los eventos nuevos entran por el principio, así que un offset se saltaría o
   * repetiría registros entre una página y la siguiente; el cursor apunta a un evento concreto
   * (fecha + id) y la continuación es exacta aunque hayan entrado cien eventos mientras tanto.
   */
  loadMore: async () => {
    const { nextCursor, loadingMore, items, filters } = get();
    if (!nextCursor || loadingMore) return;
    set({ loadingMore: true, error: null });
    try {
      const page = await auditApi.list({ ...toParams(filters), cursor: nextCursor });
      const seen = new Set(items.map((item) => item.eventId));
      set({
        items: [...items, ...page.items.filter((item) => !seen.has(item.eventId))],
        nextCursor: page.nextCursor,
        loadingMore: false,
      });
    } catch (error) {
      set({ loadingMore: false, error: describeProblem(error) });
    }
  },

  loadStats: async () => {
    try {
      set({ stats: await auditApi.stats() });
    } catch {
      set({ stats: null });
    }
  },

  reset: () => set({ ...initialState }),
}));
