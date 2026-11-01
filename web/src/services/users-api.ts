import type { Page } from '@toka/contracts/http';
import { api } from '@/lib/api';

export type UserStatus = 'ACTIVE' | 'SUSPENDED';

/** Espejo de UserView de user-service. `roles` viene de su proyección local. */
export interface UserView {
  id: string;
  email: string;
  fullName: string;
  department: string | null;
  jobTitle: string | null;
  status: UserStatus;
  statusReason: string | null;
  roles: string[];
  /** Bloqueo optimista: hay que devolverla al editar o el servidor responde 409. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserStats {
  total: number;
  active: number;
  suspended: number;
  activeAdmins: number;
  byRole: { role: string; count: number }[];
  newLast7Days: number;
}

export interface ListUsersParams {
  search?: string;
  status?: UserStatus;
  page?: number;
  pageSize?: number;
}

export interface UpdateUserInput {
  fullName?: string;
  department?: string | null;
  jobTitle?: string | null;
  version: number;
}

/** Alta de cuenta: la atiende auth-service, dueño de las credenciales, no user-service. */
export interface CreateAccountInput {
  email: string;
  password: string;
  fullName: string;
  department?: string;
  jobTitle?: string;
}

export interface AccountView {
  id: string;
  email: string;
  status: string;
}

export const usersApi = {
  list: async (params: ListUsersParams): Promise<Page<UserView>> => {
    const { data } = await api.get<Page<UserView>>('/users', { params });
    return data;
  },
  get: async (id: string): Promise<UserView> => {
    const { data } = await api.get<UserView>(`/users/${id}`);
    return data;
  },
  stats: async (): Promise<UserStats> => {
    const { data } = await api.get<UserStats>('/users/stats');
    return data;
  },
  update: async (id: string, input: UpdateUserInput): Promise<UserView> => {
    const { data } = await api.patch<UserView>(`/users/${id}`, input);
    return data;
  },
  suspend: async (id: string, reason?: string): Promise<UserView> => {
    const { data } = await api.post<UserView>(`/users/${id}/suspend`, { reason });
    return data;
  },
  reactivate: async (id: string, reason?: string): Promise<UserView> => {
    const { data } = await api.post<UserView>(`/users/${id}/reactivate`, { reason });
    return data;
  },
  /** El perfil que se captura aquí no lo guarda auth: viaja en account.registered a user-service. */
  create: async (input: CreateAccountInput): Promise<AccountView> => {
    const { data } = await api.post<AccountView>('/accounts', input);
    return data;
  },
};
