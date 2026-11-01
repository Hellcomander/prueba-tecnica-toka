import { create } from 'zustand';
import type { Permission } from '@toka/contracts/permissions';
import { clearAccessToken, setAccessToken } from './access-token';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: Permission[];
}

type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

interface AuthState {
  user: SessionUser | null;
  status: RequestStatus;
  error: string | null;
  setLoading: () => void;
  setSession: (user: SessionUser, accessToken: string) => void;
  setError: (message: string) => void;
  clearSession: () => void;
  hasPermission: (permission: Permission) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: 'idle',
  error: null,
  setLoading: () => set({ status: 'loading', error: null }),
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    set({ user, status: 'success', error: null });
  },
  setError: (error) => set({ status: 'error', error }),
  clearSession: () => {
    clearAccessToken();
    set({ user: null, status: 'idle', error: null });
  },
  hasPermission: (permission) => get().user?.permissions.includes(permission) ?? false,
}));
