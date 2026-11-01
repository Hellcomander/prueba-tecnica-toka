import { create } from 'zustand';
import { usersApi, type UserStats, type UserStatus, type UserView } from '@/services/users-api';
import { describeProblem } from '@/lib/problem';

type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

export const DEFAULT_PAGE_SIZE = 10;

interface UsersState {
  status: RequestStatus;
  error: string | null;
  items: UserView[];
  page: number;
  pageSize: number;
  total: number;
  search: string;
  statusFilter: UserStatus | 'ALL';
  stats: UserStats | null;
  setSearch: (search: string) => void;
  setStatusFilter: (status: UserStatus | 'ALL') => void;
  setPage: (page: number) => void;
  load: () => Promise<void>;
  loadStats: () => Promise<void>;
  reset: () => void;
}

const initialState = {
  status: 'idle' as RequestStatus,
  error: null,
  items: [] as UserView[],
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  search: '',
  statusFilter: 'ALL' as UserStatus | 'ALL',
  stats: null,
};

/**
 * Contador de peticiones para descartar respuestas viejas. Al escribir en el buscador salen
 * varias consultas encadenadas y la red no garantiza el orden de llegada: sin esto, la
 * respuesta de "an" puede pisar a la de "ana" y dejar en pantalla resultados que no
 * corresponden a lo que está escrito en el campo.
 */
let requestId = 0;

export const useUsersStore = create<UsersState>((set, get) => ({
  ...initialState,

  // Cambiar un filtro vuelve a la primera página: mantener la página 3 de un listado nuevo
  // suele dejar la tabla vacía sin explicación.
  setSearch: (search) => set({ search, page: 1 }),
  setStatusFilter: (statusFilter) => set({ statusFilter, page: 1 }),
  setPage: (page) => set({ page: Math.max(1, page) }),

  load: async () => {
    const { search, statusFilter, page, pageSize } = get();
    const current = ++requestId;
    set({ status: 'loading', error: null });
    try {
      const result = await usersApi.list({
        page,
        pageSize,
        search: search.trim() || undefined,
        status: statusFilter === 'ALL' ? undefined : statusFilter,
      });
      if (current !== requestId) return;
      // `page` se queda como lo dejó la interfaz y no se toma de la respuesta: la carga depende
      // de él, así que escribirlo aquí convierte cualquier discrepancia con el servidor en un
      // ciclo de peticiones. El servidor solo repite el número que se le pidió.
      set({ status: 'success', items: result.items, pageSize: result.pageSize, total: result.total });
    } catch (error) {
      if (current !== requestId) return;
      set({ status: 'error', error: describeProblem(error) });
    }
  },

  // Las estadísticas son complementarias: si fallan no se tumba el directorio, solo se ocultan.
  loadStats: async () => {
    try {
      set({ stats: await usersApi.stats() });
    } catch {
      set({ stats: null });
    }
  },

  reset: () => {
    requestId += 1;
    set({ ...initialState });
  },
}));
