import type { Permission } from '@toka/contracts/permissions';
import { api } from '@/lib/api';

/** Espejo de RoleView de role-service. Los roles de sistema (isSystem) no se editan ni borran. */
export interface RoleView {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  version: number;
}

export interface UserRolesView {
  userId: string;
  roles: { id: string; name: string }[];
  assignmentsVersion: number;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: Permission[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissions?: Permission[];
  /** Bloqueo optimista, igual que en user-service. */
  version: number;
}

export const rolesApi = {
  list: async (): Promise<RoleView[]> => {
    const { data } = await api.get<RoleView[]>('/roles');
    return data;
  },
  permissions: async (): Promise<{ code: Permission; description: string }[]> => {
    const { data } = await api.get<{ code: Permission; description: string }[]>('/permissions');
    return data;
  },
  create: async (input: CreateRoleInput): Promise<RoleView> => {
    const { data } = await api.post<RoleView>('/roles', input);
    return data;
  },
  update: async (id: string, input: UpdateRoleInput): Promise<RoleView> => {
    const { data } = await api.patch<RoleView>(`/roles/${id}`, input);
    return data;
  },
  remove: async (id: string): Promise<void> => {
    await api.delete(`/roles/${id}`);
  },
  userRoles: async (userId: string): Promise<UserRolesView> => {
    const { data } = await api.get<UserRolesView>(`/user-roles/${userId}`);
    return data;
  },
  /** Reemplaza el conjunto completo de roles del usuario (PUT, no PATCH). */
  replaceUserRoles: async (userId: string, roleIds: string[]): Promise<UserRolesView> => {
    const { data } = await api.put<UserRolesView>(`/user-roles/${userId}`, { roleIds });
    return data;
  },
};
