import { create } from 'zustand';
import type { Permission } from '@toka/contracts/permissions';
import { clearAccessToken, setAccessToken } from './access-token';

export interface SessionUser {
  id: string;
  email: string;
  /**
   * Opcional a propósito: auth-service no guarda el perfil (vive en user-service), así que el
   * login no lo trae. Se completa después con GET /users/me; mientras tanto se usa el correo.
   */
  fullName?: string;
  roles: string[];
  permissions: Permission[];
}

/** Nombre para pintar en pantalla. Nunca depende de que el perfil ya haya llegado. */
export const displayName = (user: SessionUser | null): string =>
  user?.fullName?.trim() || user?.email.split('@')[0] || '';

type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

interface AuthState {
  user: SessionUser | null;
  status: RequestStatus;
  error: string | null;
  /** True hasta que se intenta restaurar la sesión al arrancar; evita un parpadeo al login. */
  restoring: boolean;
  setLoading: () => void;
  setSession: (user: SessionUser, accessToken: string) => void;
  mergeProfile: (fields: Partial<Pick<SessionUser, 'fullName'>>) => void;
  setError: (message: string) => void;
  clearSession: () => void;
  finishRestoring: () => void;
  hasPermission: (permission: Permission) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: 'idle',
  error: null,
  restoring: true,
  setLoading: () => set({ status: 'loading', error: null }),
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    set({ user, status: 'success', error: null, restoring: false });
  },
  /** Completa el perfil cuando llega de user-service, sin pisar el resto de la sesión. */
  mergeProfile: (fields) => set((state) => (state.user ? { user: { ...state.user, ...fields } } : state)),
  setError: (error) => set({ status: 'error', error }),
  clearSession: () => {
    clearAccessToken();
    set({ user: null, status: 'idle', error: null, restoring: false });
  },
  finishRestoring: () => set({ restoring: false }),
  hasPermission: (permission) => get().user?.permissions.includes(permission) ?? false,
}));
