import { api } from '@/lib/api';
import type { SessionUser } from '@/state/auth-store';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  user: SessionUser;
}

export const authApi = {
  login: async (input: LoginInput): Promise<LoginResult> => {
    const { data } = await api.post<LoginResult>('/auth/login', input);
    return data;
  },
  logout: async (): Promise<void> => {
    await api.post('/auth/logout');
  },
};
