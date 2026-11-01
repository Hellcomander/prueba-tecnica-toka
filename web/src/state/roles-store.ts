import { create } from 'zustand';
import type { Permission } from '@toka/contracts/permissions';
import { rolesApi, type RoleView } from '@/services/roles-api';
import { describeProblem } from '@/lib/problem';

type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

interface RolesState {
  status: RequestStatus;
  error: string | null;
  roles: RoleView[];
  catalog: { code: Permission; description: string }[];
  load: () => Promise<void>;
  reset: () => void;
}

const initialState = {
  status: 'idle' as RequestStatus,
  error: null,
  roles: [] as RoleView[],
  catalog: [] as { code: Permission; description: string }[],
};

export const useRolesStore = create<RolesState>((set) => ({
  ...initialState,

  /**
   * Roles y catálogo se piden juntos: el formulario no se puede dibujar sin el catálogo, y sin
   * roles no hay nada que editar. Se resuelven en paralelo porque son servicios independientes.
   */
  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const [roles, catalog] = await Promise.all([rolesApi.list(), rolesApi.permissions()]);
      set({ status: 'success', roles, catalog });
    } catch (error) {
      set({ status: 'error', error: describeProblem(error) });
    }
  },

  reset: () => set({ ...initialState }),
}));
