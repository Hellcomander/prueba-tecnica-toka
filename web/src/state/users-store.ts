import { create } from 'zustand';

type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

interface UsersState {
  status: RequestStatus;
  error: string | null;
  setLoading: () => void;
  setSuccess: () => void;
  setError: (message: string) => void;
}

export const useUsersStore = create<UsersState>((set) => ({
  status: 'idle',
  error: null,
  setLoading: () => set({ status: 'loading', error: null }),
  setSuccess: () => set({ status: 'success', error: null }),
  setError: (error) => set({ status: 'error', error }),
}));
