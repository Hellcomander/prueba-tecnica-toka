import type { UserStatus } from '../../domain/profile/user-profile';

/** Vista de un usuario para la API (perfil + roles de la proyección local). */
export interface UserView {
  id: string;
  email: string;
  fullName: string;
  department: string | null;
  jobTitle: string | null;
  status: UserStatus;
  statusReason: string | null;
  roles: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserStats {
  total: number;
  active: number;
  suspended: number;
  /** Administradores activos (la cifra que protege la regla LAST_ADMIN). */
  activeAdmins: number;
  /** Usuarios activos por rol. */
  byRole: { role: string; count: number }[];
  /** Perfiles creados en los últimos 7 días. */
  newLast7Days: number;
}

export interface ListUsersParams {
  search?: string;
  status?: UserStatus;
  page: number;
  pageSize: number;
}

/** Lado de lectura (CQRS ligero): consultas ya con forma de vista, sin pasar por agregados. */
export interface UserReadModel {
  list(params: ListUsersParams): Promise<{ items: UserView[]; total: number }>;
  get(id: string): Promise<UserView | null>;
  stats(): Promise<UserStats>;
}

export const USER_READ_MODEL = Symbol('USER_READ_MODEL');
